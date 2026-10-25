# dsh-voice

Local voice for [DeepSeek Harness](https://github.com/AI-Scarlett/DSH-Store) (DSH): dictate your
messages and have answers read aloud, entirely on your computer.

> **Maintenance: best-effort.** Issues may go unanswered; forks are welcome.

## What it adds

- **Dictation**: a microphone button next to *Send*. Click to talk, click again to stop (10 minutes
  at most). The page converts the recording to a 16 kHz WAV, the host transcribes it with
  [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (`small` model, CPU, int8; French or
  English detected) and the text is added to the message box. It is **never sent by itself**.
- **Spoken commands**: a dictation that starts with "command …" / "commande …" becomes the matching
  slash command or skill of the session ("command web on" → `/web on`, "command science reading …"
  → `/science-reading …`). Unknown names are left as text, with a notice.
- **Read aloud**: a *Read* button under each answer, spoken by a local [Piper](https://github.com/OHF-Voice/piper1-gpl)
  voice (French or English, guessed from the text). Code blocks are skipped.
- **Never** a wake word or an always-on microphone: the browser opens the microphone on your click
  and releases it when the recording stops.

The interface is in English, and in French when DSH's language is French (tables `en` and `fr` at
the top of `client.js`).

## Install

1. The plugin:

   ```sh
   dsh plugin --profile web add github:MathieuPortmann/dsh-voice
   ```

   Requires Node `^22.19.0 || >=24` and DSH `>=0.2.0-rc.2 <0.3.0` (see [Compatibility](#compatibility)).
   Once the package is on npm, `dsh plugin --profile web add dsh-voice` works too.

2. The voice tools, once (Python 3.10 or later, about 1 GB on disk with the models). The default
   folder is `~/.dsh/tools/voice` (`<DSH_HOME>/tools/voice`):

   ```sh
   python3 -m venv ~/.dsh/tools/voice
   ~/.dsh/tools/voice/bin/pip install faster-whisper piper-tts
   ~/.dsh/tools/voice/bin/python -m piper.download_voices --download-dir ~/.dsh/tools/voice/models/piper fr_FR-siwis-medium en_US-lessac-medium
   ~/.dsh/tools/voice/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', download_root='$HOME/.dsh/tools/voice/models/whisper')"
   ```

   The last two commands download the models from the internet (Hugging Face); this is the only
   time anything is downloaded. Afterwards the worker runs offline.

3. Restart the profile. Your browser asks for the microphone on the first dictation.

## Configuration

All options have defaults; set them on the `voice` row of the profile:

| Option | Default | Meaning |
|---|---|---|
| `python` | `<DSH_HOME>/tools/voice/bin/python` | Python of the voice virtual environment |
| `modelsDir` | `<DSH_HOME>/tools/voice/models` | folder with `whisper/` and `piper/` |
| `whisperModel` | `small` | faster-whisper model size (multilingual: `base`, `small`, `medium`…) |
| `voiceFr`, `voiceEn` | `fr_FR-siwis-medium`, `en_US-lessac-medium` | Piper voices (`<modelsDir>/piper/<voice>.onnx`) |
| `hotwords` | `commande command DeepSeek DSH Ollama Piper Whisper` | words Whisper should spell right (names, jargon) |
| `threads` | `min(6, CPU threads)` | CPU threads of the worker |
| `idleMinutes` | `10` | the worker stops after this idle time (frees 1 to 2 GB of RAM) |
| `maxAudioMB` | `20` | largest recording accepted (about 10 minutes) |
| `maxReadChars` | `8000` | longest text read aloud at once |

Dictation and reading support French and English only.

## How it works

- `client.js` (page side) draws the microphone button and the *Read* buttons, records with the
  browser's `MediaRecorder`, converts to a 16 kHz mono WAV and plays the answer audio.
- `index.js` (host side) serves a small channel at `/voice-api/<stt|tts|to-command|warm>` and runs
  one long-lived Python worker (the Whisper model loads once), stopped after `idleMinutes`.
- `worker/voice_worker.py` reads one JSON request per line and answers one JSON line: transcription
  (faster-whisper; it reads the WAV itself, PyAV is not used) or speech (Piper).
- `lib/commands.js` turns "command <name> …" into `/name …` with the names of the session's commands
  and skills. It is pure JavaScript, a port of native code compared with it on 200,000 generated
  cases with identical results.

## Compatibility

| Component | Supported |
|---|---|
| Node.js | `^22.19.0 \|\| >=24.0.0` (`engines.node`) |
| DSH | `>=0.2.0-rc.2 <0.3.0`; declared as an optional `peerDependency` on `@deepseek-ai/schemastery`, the only DSH package the host side imports |
| Platform | Linux (tested); the plugin itself is pure JavaScript, the worker is Python |
| Python tools | tested with Python 3.12, faster-whisper 1.2.1, piper-tts 1.8.0 |
| Browser | a browser with `MediaRecorder` and Web Audio (current Chromium and Firefox) |
| Page | the chat page of DSH's web UI; the buttons are placed next to the *Send* and *Copy* buttons (found by their English or French labels) and may need an update when the page changes |

## Permissions and external services

Everything the plugin can touch, and what happens when it fails:

| Capability | Where | Used for | If it fails |
|---|---|---|---|
| **Microphone** | `client.js` (`getUserMedia`) | only between your two clicks on the microphone button; released right after | the page shows "microphone blocked or missing" |
| **Commands** | `index.js` (`child_process.spawn`) | starts `python -I worker/voice_worker.py` with a minimal environment (`PATH`, `HOME`, offline Hugging Face flags, thread count), in a temporary folder; stopped when idle or when DSH stops | dictation and reading show the error ("voice tools are not installed" when the Python is missing) |
| **Files** | `index.js`, worker | writes each recording and each spoken answer as a WAV in a temporary folder and deletes it after use; reads the models from `modelsDir` | the request fails with an error message |
| **Network** | none at run time | the worker runs with `HF_HUB_OFFLINE=1` and `local_files_only`; only the one-time install commands above download models | n/a |
| **HTTP route** | `index.js` (`ctx.webServer.register`) | `POST /voice-api/<method>` for the page, behind `ctx.connection.admit()` (DSH's Host/Origin fence and token); audio limited to `maxAudioMB`, JSON bodies to 1 MiB | non-admitted requests get 401/403; other errors are returned as JSON |
| **Session data** | `index.js` (`ctx.commands`, `ctx.skills`, `ctx.agents`) | reads the names of the session's commands and skills, to recognise spoken commands; nothing is written | the dictation stays plain text |
| **Dynamic module loading** | `index.js` (`importFromDsh`) | loads `@deepseek-ai/schemastery` (the config schema) from the DSH installation that runs the plugin. Nothing is downloaded and no code is evaluated from text (`eval` / `new Function` are not used) | the plugin fails to load |
| **Interface** | `client.js` | the microphone button, a status line, the *Read* buttons; registers a French dictionary and language entry with DSH's locale service | no buttons |

The plugin adds no tool for the model and never sends a message by itself.

## Verification

Checked on a disposable profile (`DSH_HOME` pointing at a temporary folder, so the real profile is
never touched):

```sh
npm pack
dsh plugin --profile t add file:$PWD/dsh-voice-0.1.0.tgz   # install
dsh t --port 3095 --no-open                                 # start: plugin loads, no error
dsh plugin --profile t remove dsh-voice                      # uninstall
```

`npm test` runs 7 standalone tests of `lib/commands.js` with no DSH installation needed.

## Develop

```sh
npm test
```

## License

MIT
