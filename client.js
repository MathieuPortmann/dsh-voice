// dsh-voice - client half (web UI).
// 1. A microphone button next to "Send": click to start, click again to stop. The
//    recording (default microphone of the PC) is turned into a 16 kHz WAV in the page
//    and transcribed on the PC; the text is added to the message box, never sent.
//    "commande <name> ..." becomes the matching /command when it exists.
// 2. A "Read" button under each answer: the answer is spoken by a local voice.
// No wake word, no always-on microphone: the microphone is opened by the click and
// released as soon as the recording stops.
window.__ModuleLoader__.load({
  id: 'dsh-voice',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-voice';
    const CHANNEL = '/voice-api';
    const MAX_SECONDS = 600;

    const fr = {
      'mic.start': 'Dicter (cliquer pour parler, cliquer à nouveau pour arrêter)',
      'mic.stop': 'Arrêter la dictée',
      'state.recording': 'Écoute… clique sur le micro pour arrêter ({s} s)',
      'state.transcribing': 'Transcription sur le PC…',
      'state.empty': 'Rien entendu. Réessaie plus près du micro.',
      'state.denied': 'Micro refusé ou absent : autorise le micro pour cette page (icône à gauche de l’adresse).',
      'state.error': 'Dictée impossible : {error}',
      'state.unknown': 'Commande « {name} » inconnue : texte laissé tel quel.',
      'state.command': 'Commande /{name} préparée : vérifie puis envoie.',
      'read': 'Lire', 'read.stop': 'Arrêter', 'read.loading': 'Préparation…', 'read.title': 'Lire la réponse à voix haute (voix locale)',
      'read.error': 'Lecture impossible : {error}',
      'close': 'Fermer',
    };
    const en = {
      'mic.start': 'Dictate (click to talk, click again to stop)',
      'mic.stop': 'Stop dictation',
      'state.recording': 'Listening… click the microphone to stop ({s} s)',
      'state.transcribing': 'Transcribing on the PC…',
      'state.empty': 'Nothing heard. Try again closer to the microphone.',
      'state.denied': 'Microphone blocked or missing: allow the microphone for this page (icon left of the address).',
      'state.error': 'Dictation failed: {error}',
      'state.unknown': 'Unknown command “{name}”: text left as it is.',
      'state.command': 'Command /{name} ready: check it, then send.',
      'read': 'Read', 'read.stop': 'Stop', 'read.loading': 'Preparing…', 'read.title': 'Read the answer aloud (local voice)',
      'read.error': 'Reading failed: {error}',
      'close': 'Close',
    };

    // ---- Audio: recording -> 16 kHz mono 16-bit WAV ----------------------------------
    function encodeWav(samples, rate) {
      const buf = new ArrayBuffer(44 + samples.length * 2);
      const v = new DataView(buf);
      const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
      v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true);
      for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
      return new Blob([buf], { type: 'audio/wav' });
    }
    async function toWav16k(blob) {
      const data = await blob.arrayBuffer();
      const ac = new AudioContext();
      try {
        const decoded = await ac.decodeAudioData(data);
        const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
        const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
        const out = await off.startRendering();
        return encodeWav(out.getChannelData(0), 16000);
      } finally { ac.close(); }
    }

    // ---- Message box (Lexical editor): add text at the end, never send -----------------
    function composer() { return document.querySelector('[data-composer-input]'); }
    function insertIntoComposer(text, replaceAll) {
      const ed = composer();
      if (!ed) return false;
      ed.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ed);
      if (!replaceAll) range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
      const before = ed.innerText.replace(/​/g, '').trim();
      const glue = !replaceAll && before && !/\s$/.test(ed.innerText) ? ' ' : '';
      return document.execCommand('insertText', false, glue + text);
    }

    const post = (path, body, type) => fetch(`${CHANNEL}/${path}`, { method: 'POST', headers: { 'content-type': type ?? 'application/json' }, body });
    const errorOf = async res => { try { return (await res.json()).error ?? `HTTP ${res.status}`; } catch { return `HTTP ${res.status}`; } };

    // ---- Shared state between the injected buttons and the dock line --------------------
    const store = { state: null, listeners: new Set(), sessionId: null };
    const setState = s => { store.state = s; for (const l of store.listeners) l(s); };
    let recorder = null, stream = null, ticker = null;

    // The host turns "commande <name> ..." into "/name ..." (lib/commands.js, with the session's commands).
    async function toCommand(text, sessionId) {
      try { const r = await post('to-command', JSON.stringify({ sessionId, text })); return r.ok ? await r.json() : { text }; }
      catch { return { text }; }
    }
    function release() { if (stream) for (const tr of stream.getTracks()) tr.stop(); stream = null; clearInterval(ticker); ticker = null; }
    async function startRecording() {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch { release(); setState({ kind: 'denied' }); return; }
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => { release(); recorder = null; transcribe(new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' })); };
      recorder.start(1000);
      post('warm', '{}').catch(() => {});
      const t0 = Date.now();
      setState({ kind: 'recording', s: 0 });
      ticker = setInterval(() => {
        const s = Math.round((Date.now() - t0) / 1000);
        if (s >= MAX_SECONDS) stopRecording(); else setState({ kind: 'recording', s });
      }, 1000);
    }
    function stopRecording() { if (recorder && recorder.state !== 'inactive') recorder.stop(); else release(); }
    async function transcribe(blob) {
      setState({ kind: 'transcribing' });
      try {
        const wav = await toWav16k(blob);
        const res = await post('stt', wav, 'audio/wav');
        if (!res.ok) throw new Error(await errorOf(res));
        let { text } = await res.json();
        text = String(text ?? '').trim();
        if (!text) { setState({ kind: 'empty' }); return; }
        if (/^\s*(commandes?|command|comment\s+de)\b/i.test(text)) {
          const r = await toCommand(text, store.sessionId);
          const empty = !(composer()?.innerText ?? '').replace(/​/g, '').trim();
          insertIntoComposer(r.text, Boolean(r.command) && empty);
          setState(r.command ? { kind: 'command', name: r.command } : { kind: 'unknown', name: r.unknown });
          return;
        }
        insertIntoComposer(text, false);
        setState(null);
      } catch (e) { setState({ kind: 'error', error: String(e?.message ?? e) }); }
    }

    // ---- Read aloud ---------------------------------------------------------------------
    let playing = null; // { audio, button }
    function stopPlaying() { if (playing) { playing.audio.pause(); playing.done(); playing = null; } }
    function answerText(turn) {
      const parts = [...document.querySelectorAll(`[data-chat-turn="${CSS.escape(turn)}"][data-turn-process-answer]`)];
      return parts.map(el => {
        const copy = el.cloneNode(true);
        copy.querySelectorAll('pre, button, [data-voice-read]').forEach(x => x.remove());
        return copy.innerText;
      }).join('\n').replace(/[#*_`>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function MicIcon(on) {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3, fill: on ? 'currentColor' : 'none' }),
        h('path', { d: 'M5 11a7 7 0 0 0 14 0M12 18v3' }));
    }

    function makeButton(label, title) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('data-voice-read', '1');
      b.style.cssText = 'font:inherit;font-size:12px;border:1px solid var(--border, #ccc);background:transparent;color:inherit;border-radius:6px;padding:1px 8px;cursor:pointer;margin-left:6px;opacity:.85';
      return b;
    }

    // Mic button placed next to "Send"; the dock line shows what is going on.
    function VoiceDock({ sessionId, t }) {
      const [state, setLocal] = React.useState(store.state);
      React.useEffect(() => { store.sessionId = sessionId; }, [sessionId]);
      React.useEffect(() => { store.listeners.add(setLocal); return () => store.listeners.delete(setLocal); }, []);
      const [host, setHost] = React.useState(null);
      React.useEffect(() => {
        // Keep a host element right before the Send button (the composer re-renders often).
        const place = () => {
          const send = document.querySelector('button[aria-label="Send message"], button[aria-label="Envoyer le message"]');
          if (!send || !send.parentElement) return;
          let el = send.parentElement.querySelector(':scope > [data-voice-mic]');
          if (!el) { el = document.createElement('span'); el.setAttribute('data-voice-mic', '1'); el.style.display = 'inline-flex'; send.parentElement.insertBefore(el, send); }
          setHost(prev => (prev === el ? prev : el));
        };
        place();
        const obs = new MutationObserver(place);
        obs.observe(document.body, { childList: true, subtree: true });
        return () => obs.disconnect();
      }, []);
      const recording = state?.kind === 'recording';
      const busy = state?.kind === 'transcribing';
      const ReactDOM = require('react-dom');
      const mic = host && ReactDOM.createPortal(h('button', {
        type: 'button', 'aria-label': t(recording ? 'mic.stop' : 'mic.start'), title: t(recording ? 'mic.stop' : 'mic.start'), disabled: busy,
        onClick: () => (recording ? stopRecording() : startRecording()),
        style: { width: 30, height: 30, borderRadius: 15, border: 'none', cursor: busy ? 'wait' : 'pointer', marginRight: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: recording ? '#c62828' : 'transparent', color: recording ? '#fff' : 'inherit', opacity: busy ? 0.5 : 1 },
      }, MicIcon(recording)), host);
      const line = state && h('div', { role: state.kind === 'error' || state.kind === 'denied' ? 'alert' : 'status', style: { fontSize: 12, padding: '4px 10px', display: 'flex', gap: 8, alignItems: 'center', color: state.kind === 'error' || state.kind === 'denied' ? '#c62828' : 'inherit', opacity: 0.9 } },
        h('span', null, t(`state.${state.kind}`, state)),
        !recording && !busy && h('button', { type: 'button', onClick: () => setState(null), style: { font: 'inherit', fontSize: 12, border: 'none', background: 'transparent', textDecoration: 'underline', cursor: 'pointer', color: 'inherit' } }, t('close')));
      return h(React.Fragment, null, mic, line || null);
    }

    function addReadButtons(t) {
      for (const tail of document.querySelectorAll('[data-chat-flow-kind="turn-tail"]')) {
        if (tail.querySelector('[data-voice-read]')) continue;
        const copy = tail.querySelector('button[aria-label="Copy"], button[aria-label="Copier"]');
        const row = copy?.parentElement ?? tail;
        const turn = tail.getAttribute('data-chat-turn');
        if (!turn) continue;
        const b = makeButton(t('read'), t('read.title'));
        b.addEventListener('click', async () => {
          if (playing?.button === b) { stopPlaying(); return; }
          stopPlaying();
          const text = answerText(turn);
          if (!text) return;
          b.textContent = t('read.loading'); b.disabled = true;
          try {
            const res = await post('tts', JSON.stringify({ text }));
            if (!res.ok) throw new Error(await errorOf(res));
            const url = URL.createObjectURL(await res.blob());
            const audio = new Audio(url);
            const done = () => { URL.revokeObjectURL(url); b.textContent = t('read'); b.disabled = false; if (playing?.button === b) playing = null; };
            playing = { audio, button: b, done };
            audio.onended = done;
            b.textContent = t('read.stop'); b.disabled = false;
            await audio.play();
          } catch (e) { b.textContent = t('read'); b.disabled = false; b.title = t('read.error', { error: String(e?.message ?? e) }); }
        });
        row.appendChild(b);
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => { try { return ctx.locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' }); } catch { return () => {}; } }, 'dsh-voice: french language');
        ctx.effect(() => ctx.locale.register(NS, { zh: en, en }), 'dsh-voice: dictionaries');
        ctx.effect(() => { try { return ctx.locale.register(NS, 'fr', fr); } catch { return () => {}; } }, 'dsh-voice: french dictionary');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: 'dsh-voice/dock', order: 6, locale: NS,
          inject: sessionId => ({ sessionId, t }),
        }, VoiceDock));
        ctx.effect(() => {
          // A short timer, not requestAnimationFrame: rAF never fires while the page is
          // in the background, and the buttons should be there when it comes back.
          let timer = 0;
          const schedule = () => { if (!timer) timer = setTimeout(() => { timer = 0; addReadButtons(t); }, 50); };
          const obs = new MutationObserver(schedule);
          obs.observe(document.body, { childList: true, subtree: true });
          schedule();
          return () => { obs.disconnect(); stopPlaying(); stopRecording(); document.querySelectorAll('[data-voice-read], [data-voice-mic]').forEach(x => x.remove()); };
        }, 'dsh-voice: read buttons');
      },
    };
  },
});
