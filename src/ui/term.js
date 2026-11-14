// Terminal output: colour detection, Symfony-style status badges, sections and messages.
import { padEnd, sanitize, visibleWidth } from './format.js';

const state = {
  color: false,
  unicode: true,
  out: process.stdout,
  err: process.stderr,
};

/**
 * Decide whether ANSI colours should be used.
 * Order: --no-color / --color flags, NO_COLOR, FORCE_COLOR, TERM=dumb, TTY detection.
 */
export function detectColor({ flag, env = process.env, stream = process.stdout } = {}) {
  if (flag === false) return false;
  if (flag === true) return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  if (env.TERM === 'dumb') return false;
  return Boolean(stream && stream.isTTY);
}

/** Legacy Windows consoles (conhost without Windows Terminal) often lack box/braille glyphs. */
export function detectUnicode({ env = process.env, platform = process.platform } = {}) {
  if (env.MESHCLI_ASCII === '1') return false;
  if (platform !== 'win32') return env.TERM !== 'linux';
  return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || env.TERMINAL_EMULATOR);
}

export function configureTerminal({ color, unicode, out, err } = {}) {
  if (color !== undefined) state.color = color;
  if (unicode !== undefined) state.unicode = unicode;
  if (out) state.out = out;
  if (err) state.err = err;
}

export const isColor = () => state.color;
export const isUnicode = () => state.unicode;

const paint = (code) => (text) => (state.color ? `\x1b[${code}m${text}\x1b[0m` : String(text));
export const c = {
  bold: paint('1'),
  dim: paint('2'),
  italic: paint('3'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  gray: paint('90'),
};

export const sym = {
  get dot() { return state.unicode ? '·' : '-'; },
  get pointer() { return state.unicode ? '❯' : '>'; },
  get arrow() { return state.unicode ? '→' : '->'; },
  get ellipsis() { return state.unicode ? '…' : '...'; },
  get barFull() { return state.unicode ? '█' : '#'; },
  get barEmpty() { return state.unicode ? '░' : '-'; },
};

// Badge colours: background + foreground, as in Symfony Console's block style.
const BADGES = {
  ok: ['OK', '42;30'],
  fail: ['FAIL', '41;97'],
  warn: ['WARN', '43;30'],
  skip: ['SKIP', '43;30'],
  info: ['INFO', '44;97'],
  note: ['NOTE', '46;30'],
};
export const BADGE_WIDTH = 6;

/** A fixed-width status label, centred: a coloured block with colours on, plain text ("  OK  ") without. */
export function badge(kind) {
  const [word, code] = BADGES[kind] || BADGES.info;
  const left = Math.floor((BADGE_WIDTH - word.length) / 2);
  const text = ' '.repeat(left) + word + ' '.repeat(BADGE_WIDTH - word.length - left);
  return state.color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function write(stream, text = '') { stream.write(`${text}\n`); }
export const print = (text = '') => write(state.out, text);
export const printErr = (text = '') => write(state.err, text);

/** Top heading, e.g. "MeshCentral" followed by an indented detail line. */
export function title(text, detail) {
  print();
  print(`${c.bold(c.cyan(text))}${detail ? `  ${c.dim(detail)}` : ''}`);
}

export function section(text) {
  print();
  print(c.bold(c.yellow(text)));
}

/** A status row inside a section: "   OK    Lenovo3      Windows · online". */
export function item(kind, text, meta, { indent = 2, width = 0 } = {}) {
  const main = width ? padEnd(text, width) : text;
  print(`${' '.repeat(indent)}${badge(kind)} ${main}${meta ? `  ${c.dim(meta)}` : ''}`);
}

/** Final result line (Symfony "[OK] Done." block), with a blank line before it. */
export function result(kind, text) {
  const stream = kind === 'fail' ? state.err : state.out;
  write(stream);
  write(stream, `${badge(kind)} ${c.bold(text)}`);
}

/** A status line without leading blank, for progress messages during a command. */
export function status(kind, text) {
  const stream = kind === 'fail' ? state.err : state.out;
  write(stream, `${badge(kind)} ${text}`);
}

export function detail(text, indent = 4) { print(`${' '.repeat(indent)}${c.dim(text)}`); }

/** Key/value pairs aligned on the key column. */
export function keyValues(rows, { indent = 2 } = {}) {
  const keyWidth = Math.max(0, ...rows.filter(Boolean).map(([k]) => visibleWidth(k)));
  for (const row of rows) {
    if (!row) continue;
    const [k, v] = row;
    print(`${' '.repeat(indent)}${c.gray(padEnd(k, keyWidth))}  ${v ?? c.dim('—')}`);
  }
}

/** Simple aligned table. columns: [{key, label, color?}] */
export function table(rows, columns, { indent = 2, header = true } = {}) {
  const widths = columns.map((col) => Math.max(header ? visibleWidth(col.label) : 0, ...rows.map((r) => visibleWidth(r[col.key] ?? ''))));
  if (header) print(' '.repeat(indent) + columns.map((col, i) => c.gray(padEnd(col.label, widths[i]))).join('  '));
  for (const r of rows) {
    print(' '.repeat(indent) + columns.map((col, i) => {
      const value = String(r[col.key] ?? '');
      return padEnd(col.color ? col.color(value, r) : value, widths[i]);
    }).join('  ').trimEnd());
  }
}

/** Print an error with context and hints, Symfony-style. */
export function printError(error, { debug = false } = {}) {
  const message = sanitize(error?.message || String(error));
  write(state.err);
  write(state.err, `${badge('fail')} ${c.bold(message)}`);
  if (Array.isArray(error?.details)) for (const d of error.details) write(state.err, `       ${c.dim(sanitize(d))}`);
  if (error?.hint) write(state.err, `       ${c.cyan(sanitize(error.hint))}`);
  if (debug && error?.stack) write(state.err, c.dim(error.stack));
  if (debug && error?.cause) write(state.err, c.dim(`Caused by: ${error.cause?.stack || error.cause}`));
}
