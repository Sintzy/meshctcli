// Argument parsing on top of node:util parseArgs.
import { parseArgs } from 'node:util';
import { UsageError } from '../errors.js';

export const GLOBAL_OPTIONS = {
  profile: { type: 'string', short: 'p' },
  'no-color': { type: 'boolean' },
  color: { type: 'boolean' },
  json: { type: 'boolean' },
  debug: { type: 'boolean' },
  timeout: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
};

const VALUE_FLAGS = new Set(Object.entries(GLOBAL_OPTIONS).filter(([, o]) => o.type === 'string').flatMap(([k, o]) => [`--${k}`, o.short && `-${o.short}`].filter(Boolean)));

/** Find the command word: the first token that is not a global option (or its value). */
export function splitCommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--') return { index: -1, word: null };
    if (VALUE_FLAGS.has(t)) { i++; continue; }
    if (t.startsWith('-')) continue;
    return { index: i, word: t };
  }
  return { index: -1, word: null };
}

/**
 * Parse argv for a command definition.
 * @param {string[]} argv tokens without the command word
 * @param {{ options?: object, positionals?: {name:string, required?:boolean, rest?:boolean}[] }} spec
 */
export function parseCommandArgs(argv, spec = {}) {
  const options = { ...GLOBAL_OPTIONS, ...(spec.options || {}) };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(`${err.message.replace(/^TypeError \[[A-Z_]+\]: /, '').split('. ')[0].replace(/\.$/, '')}.`, { hint: 'Run "mesh help <command>" for usage.' });
  }
  const values = { ...parsed.values };
  if (values['no-color']) values.color = false;
  const args = {};
  const pos = [...parsed.positionals];
  for (const p of spec.positionals || []) {
    if (p.rest) { args[p.name] = pos.splice(0); continue; }
    args[p.name] = pos.length ? pos.shift() : undefined;
    if (p.required && args[p.name] === undefined) throw new UsageError(`Missing argument <${p.name}>.`, { hint: 'Run "mesh help <command>" for usage.' });
  }
  if (pos.length) throw new UsageError(`Unexpected argument "${pos[0]}".`, { hint: 'Quote values that contain spaces, e.g. "C:\\My Files".' });
  if (values.timeout !== undefined) {
    const n = Number(values.timeout);
    if (!Number.isFinite(n) || n <= 0) throw new UsageError('--timeout must be a positive number of seconds.');
    values.timeout = n * 1000;
  }
  return { args, opts: values };
}

/** Light pre-scan for global flags, used before we know which command runs (e.g. colour setup). */
export function scanGlobalFlags(argv) {
  const has = (name) => argv.includes(name);
  return {
    color: has('--no-color') ? false : has('--color') ? true : undefined,
    debug: has('--debug'),
    json: has('--json'),
  };
}
