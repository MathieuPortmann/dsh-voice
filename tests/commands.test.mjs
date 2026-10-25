// node --test tests/  (spoken commands: "commande web on" -> "/web on")
import test from 'node:test';
import assert from 'node:assert/strict';
import { toCommand, normalize } from '../lib/commands.js';

const names = ['web', 'notes', 'science-reading', 'fr', 'explain', 'remember'];
const cmd = text => toCommand(text, names);

test('plain dictation is left as it is', () => {
  assert.deepEqual(cmd('Bonjour, peux-tu relire ce texte ?'), { text: 'Bonjour, peux-tu relire ce texte ?' });
  assert.deepEqual(cmd('Bonjour.'), { text: 'Bonjour.' });
});

test('"commande web on" becomes /web on', () => {
  assert.deepEqual(cmd('Commande web on.'), { text: '/web on', command: 'web' });
  assert.deepEqual(cmd('command explain'), { text: '/explain', command: 'explain' });
  assert.deepEqual(cmd('COMMANDES  fr'), { text: '/fr', command: 'fr' });
});

test('multi-word names and arguments with punctuation', () => {
  assert.deepEqual(cmd('commande science reading, résume cet article'), { text: '/science-reading résume cet article', command: 'science-reading' });
  assert.deepEqual(cmd('Command notes, add a task for tomorrow.'), { text: '/notes add a task for tomorrow', command: 'notes' });
});

test('unknown command: text kept, word reported', () => {
  assert.deepEqual(cmd('commande météo demain'), { text: 'commande météo demain', unknown: 'météo' });
  assert.deepEqual(cmd('commande'), { text: 'commande', unknown: '' });
});

test('argument glued to the name by Whisper', () => {
  assert.deepEqual(cmd('commande webon'), { text: '/web on', command: 'web' });
  assert.deepEqual(cmd('commande fréquente'), { text: 'commande fréquente', unknown: 'fréquente' });
});

test('"comment de" (misheard "commande") only converts a real command', () => {
  assert.deepEqual(cmd('Comment de science reading résume cet article ?'), { text: '/science-reading résume cet article ?', command: 'science-reading' });
  assert.deepEqual(cmd('Comment de faire une figure ?'), { text: 'Comment de faire une figure ?' });
});

test('names are compared without accents, case or signs', () => {
  assert.equal(normalize('Science-Réading'), 'sciencereading');
  assert.deepEqual(cmd('Science-Réading'), { text: 'Science-Réading' });
  assert.deepEqual(toCommand('commande web', []), { text: 'commande web', unknown: 'web' });
});
