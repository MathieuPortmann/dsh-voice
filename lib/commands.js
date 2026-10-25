/**
 * Spoken commands: a dictation that starts with "commande", "command" or the
 * frequent mishearing "comment de" becomes "/name rest" when the next one to
 * three words name a known command ("commande web on" -> "/web on",
 * "commande science reading ..." -> "/science-reading ..."). Only names given by
 * the caller (the session's commands and skills) are used. Pure function, no
 * dependency (unit-tested in tests/).
 *
 * Character classes follow Unicode (`White_Space`, word characters) because this
 * is a port of native code and both versions must give the same result.
 */
const WS = '\\p{White_Space}';
const W = '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}]';
const TRIGGER = new RegExp(`^${WS}*(?:commandes?|command|comment${WS}+de)(?!${W})[${WS},.:;!-]*`, 'iu');
// "comment de" is also ordinary French: without a known command it stays text.
const WEAK = new RegExp(`^${WS}*comment${WS}+de(?!${W})`, 'iu');
const TRIM = new RegExp(`^${WS}+|${WS}+$`, 'gu');
const SPACES = new RegExp(`${WS}+`, 'u');
const LEADING_PUNCT = new RegExp(`^[,;:.${WS}-]+`, 'u');

/** "Science-Réading" -> "sciencereading": no accents, lower case, ASCII letters and digits only. */
export const normalize = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Dictated text -> `{ text, command? , unknown? }`. `command` is set when a command
 * was found; `unknown` when the dictation asked for a command that does not exist.
 */
export function toCommand(text, names = []) {
  text = String(text ?? '');
  const m = TRIGGER.exec(text);
  if (!m) return { text };
  const weak = WEAK.test(text);
  const body = text.slice(m[0].length).replace(TRIM, '').replace(/[.!]+$/u, '');
  const words = body.split(SPACES).filter(Boolean);
  if (words.length === 0) return weak ? { text } : { text, unknown: '' };
  const keys = names.map(n => [normalize(n), String(n)]);
  const lookup = k => keys.find(([key]) => key === k)?.[1];
  const found = (name, rest) => ({ text: rest ? `/${name} ${rest}` : `/${name}`, command: name });
  // The longest run of 1 to 3 spoken words that names a command wins.
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const name = lookup(normalize(words.slice(0, n).join('')));
    if (name !== undefined) return found(name, words.slice(n).join(' ').replace(LEADING_PUNCT, ''));
  }
  // Whisper sometimes glues the argument to the name: "webon".
  const first = normalize(words[0]);
  let glued;
  for (const kv of keys) {
    const [k] = kv;
    if (k.length >= 3 && first.length > k.length && first.startsWith(k) && (!glued || k.length >= glued[0].length)) glued = kv;
  }
  if (glued) return found(glued[1], [first.slice(glued[0].length), ...words.slice(1)].join(' '));
  return weak ? { text } : { text, unknown: words[0].replace(/[,;:]+$/u, '') };
}
