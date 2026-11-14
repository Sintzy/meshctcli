// Interactive prompts: text, hidden secret, confirmation. All prompts render on stderr so that
// stdout stays clean for piping.
import readline from 'node:readline';
import { c } from './term.js';
import { CancelledError, UsageError } from '../errors.js';

export const isInteractive = () => Boolean(process.stdin.isTTY && process.stderr.isTTY);

function requireTty(what) {
  if (!process.stdin.isTTY) throw new UsageError(`${what} needs an interactive terminal.`, { hint: 'Pass the value with a command-line option or an environment variable instead.' });
}

function questionLine(label, def) {
  return `${c.cyan('?')} ${c.bold(label)}${def !== undefined && def !== null && def !== '' ? c.dim(` (${def})`) : ''} `;
}

/** Ask for a line of text. */
export function ask(label, { default: def, validate, allowEmpty = false } = {}) {
  requireTty(`Prompt "${label}"`);
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let done = false;
    rl.on('SIGINT', () => { done = true; rl.close(); process.stderr.write('\n'); reject(new CancelledError()); });
    rl.on('close', () => { if (!done) reject(new CancelledError()); });
    const loop = () => rl.question(questionLine(label, def), (answer) => {
      let value = answer.trim();
      if (!value && def !== undefined && def !== null) value = String(def);
      if (!value && !allowEmpty) return loop();
      const problem = validate ? validate(value) : null;
      if (problem) { process.stderr.write(`  ${c.red(problem)}\n`); return loop(); }
      done = true;
      rl.close();
      resolve(value);
    });
    loop();
  });
}

/**
 * Ask for a secret without echo. Uses raw mode and reads keystrokes directly; the value never
 * touches argv, the environment or shell history. Non-TTY: reads one line from stdin.
 */
export function secret(label) {
  if (!process.stdin.isTTY) return readStdinLine();
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(`${questionLine(label)}${c.dim('(hidden)')} `);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const finish = (err) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write('\n');
      if (err) reject(err); else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') return finish(new CancelledError());
        if (ch === '\u007f' || ch === '\b') { value = [...value].slice(0, -1).join(''); continue; }
        if (ch === '\u0015') { value = ''; continue; } // Ctrl+U
        if (ch < ' ' && ch !== '\t') continue;
        value += ch;
      }
    };
    input.on('data', onData);
  });
}

function readStdinLine() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    const onData = (chunk) => {
      data += chunk;
      const i = data.indexOf('\n');
      if (i >= 0) { cleanup(); resolve(data.slice(0, i).replace(/\r$/, '')); }
    };
    const onEnd = () => { cleanup(); data ? resolve(data.replace(/\r?\n$/, '')) : reject(new UsageError('No input on stdin.')); };
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.pause(); };
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.resume();
  });
}

/** Yes/no question. */
export async function confirm(label, { default: def = false } = {}) {
  const answer = await ask(`${label} ${c.dim(def ? '[Y/n]' : '[y/N]')}`, { allowEmpty: true });
  if (!answer) return def;
  return /^(y|yes)$/i.test(answer);
}

/** Confirmation for destructive actions: the user must type the device name (or "yes"). */
export async function confirmDangerous(action, target, { expected } = {}) {
  requireTty('Confirmation');
  const word = expected || target;
  const answer = await ask(`${action} ${c.bold(target)}? Type ${c.yellow(word)} to confirm:`, { allowEmpty: true });
  return answer === word;
}
