"""Local voice worker for dsh-voice (started by index.js, one process, stopped when idle).

Usage: voice_worker.py <models dir> [whisper size] [hotwords] [voices JSON]

One JSON request per line on stdin, one JSON answer per line on stdout:
  {"id": 1, "op": "stt", "path": "/tmp/x.wav"}            -> {"id": 1, "text": "...", "language": "fr"}
  {"id": 2, "op": "tts", "text": "...", "lang": "fr", "out": "/tmp/y.wav"} -> {"id": 2, "path": "/tmp/y.wav"}
  {"id": 3, "op": "warm"}                                   -> {"id": 3, "warm": true} (loads Whisper)
Errors: {"id": n, "error": "..."}.

Speech to text: faster-whisper (multilingual, "small" by default) on the CPU, int8; the
language is detected and limited to French or English. Text to speech: Piper voices.
The models were downloaded once into <models dir>; the worker never goes online
(HF_HUB_OFFLINE, local_files_only).
"""
import json
import os
import sys
import wave

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

MODELS = sys.argv[1]
WHISPER_SIZE = sys.argv[2] if len(sys.argv) > 2 else "small"
# Names Whisper does not know; given as hotwords so they are spelled right.
HOTWORDS = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3].strip() else None
VOICES = {"fr": "fr_FR-siwis-medium", "en": "en_US-lessac-medium"}
if len(sys.argv) > 4:
    VOICES.update(json.loads(sys.argv[4]))

_whisper = None
_voices = {}


def whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        _whisper = WhisperModel(WHISPER_SIZE, device="cpu", compute_type="int8",
                                download_root=os.path.join(MODELS, "whisper"), local_files_only=True)
    return _whisper


def read_wav(path):
    """16-bit PCM WAV (the page sends 16 kHz mono) -> float32 samples, without PyAV."""
    import numpy as np
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("expected 16-bit PCM WAV")
        rate, channels, frames = w.getframerate(), w.getnchannels(), w.readframes(w.getnframes())
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        n = int(len(audio) * 16000 / rate)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    return audio


def stt(path):
    model = whisper()
    audio = read_wav(path)
    segments, info = model.transcribe(audio, vad_filter=True, beam_size=5, hotwords=HOTWORDS)
    language = info.language
    if language not in ("fr", "en"):
        probs = dict(info.all_language_probs or [])
        language = "fr" if probs.get("fr", 0) >= probs.get("en", 0) else "en"
        segments, info = model.transcribe(audio, language=language, vad_filter=True, beam_size=5, hotwords=HOTWORDS)
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "language": language}


def tts(text, lang, out):
    from piper import PiperVoice
    name = VOICES.get(lang, VOICES["fr"])
    if name not in _voices:
        _voices[name] = PiperVoice.load(os.path.join(MODELS, "piper", name + ".onnx"))
    with wave.open(out, "wb") as w:
        _voices[name].synthesize_wav(text, w)
    return {"path": out}


def main():
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            if req.get("op") == "stt":
                res = stt(req["path"])
            elif req.get("op") == "tts":
                res = tts(req["text"], req.get("lang", "fr"), req["out"])
            elif req.get("op") == "warm":
                whisper()
                res = {"warm": True}
            else:
                raise ValueError("unknown op")
            res["id"] = req.get("id")
        except Exception as e:  # report and keep serving
            res = {"id": req.get("id"), "error": f"{type(e).__name__}: {e}"}
        print(json.dumps(res, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
