/**
 * dsh-voice - host half.
 *
 * - Dictation: the page records only while the microphone button is on, then sends a
 *   16 kHz mono WAV here; a local worker (faster-whisper, CPU) turns it into text,
 *   French or English. The text goes into the message box; nothing is sent.
 * - Read aloud: the "Read" button under an answer sends its text here; the worker
 *   speaks it with a local Piper voice and the page plays the WAV.
 * - No wake word, no always-on microphone. Nothing leaves the computer: the models
 *   are downloaded once into `modelsDir` and the worker runs offline.
 * - "commande <name>" / "command <name>" is turned into the slash command here
 *   (lib/commands.js), with the commands and skills of the session.
 * The channel /voice-api is protected like DSH's own channels (connection.admit).
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { toCommand } from './lib/commands.js';

const dshRequire = createRequire(realpathSync(process.argv[1]));
const importFromDsh = id => import(pathToFileURL(dshRequire.resolve(id)).href);
const schemastery = await importFromDsh('@deepseek-ai/schemastery');
const Schema = schemastery.default ?? schemastery;

export const name = 'voice';
export const inject = ['connection', 'webServer', 'agents', 'commands', 'skills'];

const TOOLS = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'tools', 'voice');
export const Config = Schema.object({
  python: Schema.string().default(join(TOOLS, 'bin', 'python')).description('Python of the voice virtual environment (faster-whisper, piper-tts).'),
  modelsDir: Schema.string().default(join(TOOLS, 'models')).description('Downloaded models: whisper/ and piper/.'),
  whisperModel: Schema.string().default('small').description('faster-whisper model size (multilingual).'),
  voiceFr: Schema.string().default('fr_FR-siwis-medium').description('Piper voice for French (file <modelsDir>/piper/<voice>.onnx).'),
  voiceEn: Schema.string().default('en_US-lessac-medium').description('Piper voice for English.'),
  hotwords: Schema.string().default('commande command DeepSeek DSH Ollama Piper Whisper').description('Words Whisper should spell right (names, jargon), separated by spaces.'),
  threads: Schema.number().min(1).default(Math.min(6, availableParallelism())).description('CPU threads used by the worker.'),
  idleMinutes: Schema.number().min(1).default(10).description('The worker stops after this many idle minutes (frees 1 to 2 GB of RAM).'),
  maxAudioMB: Schema.number().min(1).default(20).description('Largest recording accepted (16 kHz WAV: about 10 minutes for 20 MB).'),
  maxReadChars: Schema.number().min(200).default(8000).description('Longest text read aloud at once.'),
});

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'worker', 'voice_worker.py');
const CHANNEL = '/voice-api';

/** One long-lived worker (the Whisper model loads once), stopped when idle. */
function createWorker(config, log) {
  let proc = null, ready = null, nextId = 1, idleTimer = null;
  const waiting = new Map();
  const stop = () => { if (proc) { try { proc.kill(); } catch { /* gone */ } } proc = null; ready = null; };
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(stop, config.idleMinutes * 60_000); idleTimer.unref?.(); };
  const start = () => {
    if (ready) return ready;
    if (!existsSync(config.python)) return Promise.reject(new Error(`voice tools are not installed (${config.python} is missing)`));
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-voice-cwd-'));
    const voices = JSON.stringify({ fr: config.voiceFr, en: config.voiceEn });
    // -I: isolated mode (ignores PYTHON* variables and the current folder).
    proc = spawn(config.python, ['-I', WORKER, config.modelsDir, config.whisperModel, config.hotwords, voices], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: homedir(), HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', OMP_NUM_THREADS: String(config.threads) },
    });
    const p = proc;
    ready = new Promise((resolve, reject) => {
      const lines = createInterface({ input: p.stdout });
      lines.on('line', line => {
        let msg; try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready) return resolve();
        const w = waiting.get(msg.id); if (!w) return;
        waiting.delete(msg.id);
        msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg);
      });
      let err = '';
      p.stderr.on('data', d => { err = (err + d).slice(-2000); });
      p.on('error', e => { if (proc === p) { proc = null; ready = null; } reject(e); });
      p.on('exit', code => {
        if (proc === p) { proc = null; ready = null; }
        rmSync(cwd, { recursive: true, force: true });
        const e = new Error(`voice worker stopped (code ${code}): ${err.trim().split('\n').pop() ?? ''}`);
        reject(e);
        for (const w of waiting.values()) w.reject(e);
        waiting.clear();
        if (code) log(e.message);
      });
    });
    return ready;
  };
  async function call(req) {
    await start();
    touch();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      proc.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
    }).finally(touch);
  }
  return { call, stop };
}

/** Very small guess: French when common French words outnumber English ones. */
export function guessLang(text) {
  const words = String(text).toLowerCase().match(/[a-zàâçéèêëîïôûùüÿœ']+/g) ?? [];
  const fr = new Set(['le', 'la', 'les', 'des', 'une', 'est', 'et', 'pour', 'dans', 'que', 'qui', 'pas', 'sur', 'avec', 'du', 'ce', 'il', 'tu', 'je', 'à', 'au']);
  const en = new Set(['the', 'is', 'and', 'for', 'in', 'that', 'with', 'not', 'on', 'of', 'to', 'this', 'it', 'you', 'are', 'be']);
  let f = 0, e = 0;
  for (const w of words) { if (fr.has(w)) f++; if (en.has(w)) e++; }
  return e > f ? 'en' : 'fr';
}

export function apply(ctx, config) {
  const log = message => console.warn(`[dsh-voice] ${message}`);
  const worker = createWorker(config, log);
  ctx.effect(() => () => worker.stop(), 'dsh-voice: worker');
  const tmp = join(tmpdir(), `dsh-voice-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  let n = 0;

  const readBody = async (req, limit) => {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
    return Buffer.concat(chunks);
  };
  const handlers = {
    // 16 kHz mono 16-bit WAV -> { text, language }
    async stt(req) {
      const body = await readBody(req, config.maxAudioMB * 1024 * 1024);
      if (body.length < 44 || body.toString('ascii', 0, 4) !== 'RIFF') throw Object.assign(new Error('expected a WAV recording'), { status: 400 });
      const file = join(tmp, `in-${++n}.wav`);
      writeFileSync(file, body);
      try { const r = await worker.call({ op: 'stt', path: file }); return { json: { text: r.text ?? '', language: r.language } }; }
      finally { rmSync(file, { force: true }); }
    },
    // { text, lang? } -> audio/wav
    async tts(req) {
      const { text, lang } = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, config.maxReadChars);
      if (!clean) throw Object.assign(new Error('nothing to read'), { status: 400 });
      const file = join(tmp, `out-${++n}.wav`);
      try { await worker.call({ op: 'tts', text: clean, lang: lang === 'en' || lang === 'fr' ? lang : guessLang(clean), out: file }); return { wav: readFileSync(file) }; }
      finally { rmSync(file, { force: true }); }
    },
    // { sessionId, text } -> { text, command?, unknown? }: "commande web on" -> "/web on"
    async 'to-command'(req) {
      const { sessionId, text } = JSON.parse((await readBody(req, 1 << 16)).toString('utf8') || '{}');
      const agent = sessionId ? ctx.agents.get(sessionId) : undefined;
      let names = [];
      if (agent) {
        // Slash commands of the session, then the skills (also typed as /name).
        const list = await ctx.commands.list(agent);
        const skills = await ctx.skills.list({ cwd: agent.session?.header?.cwd, scope: agent }).catch(e => { log(`skill list failed: ${e?.message ?? e}`); return []; });
        names = [...new Set([...(list ?? []), ...(skills ?? [])].map(c => c?.name).filter(Boolean))];
      }
      return { json: toCommand(String(text ?? ''), names) };
    },
    // Loads the Whisper model while the user is still speaking.
    async warm() { worker.call({ op: 'warm' }).catch(() => {}); return { json: { ok: true } }; },
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: CHANNEL,
    handler: async (req, res) => {
      const admission = ctx.connection.admit(req);
      if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden'); return; }
      const endpoint = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.slice(CHANNEL.length + 1));
      const h = Object.prototype.hasOwnProperty.call(handlers, endpoint) ? handlers[endpoint] : undefined;
      if (req.method !== 'POST' || !h) { res.writeHead(404); res.end('not found'); return; }
      try {
        const r = await h(req);
        if (r.wav) { res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' }); res.end(r.wav); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(r.json));
      } catch (e) {
        res.writeHead(e?.status ?? 500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: String(e?.message ?? e).slice(0, 300) }));
      }
    },
  }), 'dsh-voice: page channel');
  ctx.effect(() => () => rmSync(tmp, { recursive: true, force: true }), 'dsh-voice: temporary files');
}
