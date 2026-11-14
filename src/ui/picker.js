// Interactive list picker with incremental search and arrow-key navigation.
// Rendering is a pure function (renderPicker) so it can be unit-tested.
import readline from 'node:readline';
import { c, sym, badge } from './term.js';
import { padEnd, truncate } from './format.js';
import { UsageError } from '../errors.js';

const fold = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();

/** Rank items for a query: prefix matches first, then substring, then subsequence ("fuzzy"). */
export function filterItems(items, query) {
  const q = fold(query.trim());
  if (!q) return items;
  const scored = [];
  for (const item of items) {
    const text = fold(item.search ?? item.label);
    let score = -1;
    if (text.startsWith(q)) score = 0;
    else if (text.includes(q)) score = 1;
    else if (isSubsequence(q, text)) score = 2;
    if (score >= 0) scored.push({ item, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.item);
}

function isSubsequence(q, text) {
  let i = 0;
  for (const ch of text) if (ch === q[i]) i++;
  return i === q.length;
}

/** Produce the lines of the picker for a given state. */
export function renderPicker({ title, query, items, selected, pageSize, width = 80 }) {
  const shown = filterItems(items, query);
  const sel = Math.min(selected, Math.max(0, shown.length - 1));
  const start = Math.max(0, Math.min(sel - Math.floor(pageSize / 2), shown.length - pageSize));
  const page = shown.slice(start, start + pageSize);
  const labelWidth = Math.min(32, Math.max(8, ...page.map((i) => i.label.length)));
  const lines = [
    `${c.cyan('?')} ${c.bold(title)}  ${c.dim('↑↓ move · type to filter · Enter select · Esc cancel')}`,
    `  ${c.yellow('Search:')} ${query || c.dim('(all)')} ${c.dim(`${shown.length}/${items.length}`)}`,
  ];
  page.forEach((it, i) => {
    const active = start + i === sel;
    const label = padEnd(truncate(it.label, labelWidth), labelWidth);
    const hint = it.hint ? c.dim(truncate(it.hint, Math.max(10, width - labelWidth - 16))) : '';
    lines.push(`${active ? c.cyan(sym.pointer) : ' '} ${it.badge ? `${badge(it.badge)} ` : ''}${active ? c.bold(label) : label}  ${hint}`);
  });
  if (!shown.length) lines.push(`  ${c.red('No matches')}`);
  if (shown.length > pageSize) lines.push(c.dim(`  ${start + 1}-${start + page.length} of ${shown.length}`));
  return { lines, shown, selected: sel };
}

/**
 * Show the picker and resolve with the chosen item's value, or null if cancelled.
 * @param {{label:string, hint?:string, badge?:string, search?:string, value:any}[]} items
 */
export function pick(items, { title = 'Select', initialQuery = '' } = {}) {
  const input = process.stdin;
  const out = process.stderr;
  if (!input.isTTY || !out.isTTY || typeof input.setRawMode !== 'function') {
    throw new UsageError('Interactive selection needs a terminal.', { hint: 'Pass the device name explicitly, e.g. "mesh shell <name>".' });
  }
  return new Promise((resolve) => {
    let query = initialQuery;
    let selected = 0;
    let drawn = 0;
    let shown = [];
    const wasRaw = input.isRaw;
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    out.write('\x1b[?25l'); // hide cursor

    const pageSize = () => Math.max(3, Math.min(12, (out.rows || 24) - 5));
    function draw() {
      const r = renderPicker({ title, query, items, selected, pageSize: pageSize(), width: out.columns || 80 });
      shown = r.shown; selected = r.selected;
      if (drawn) out.write(`\x1b[${drawn}A`);
      const total = Math.max(drawn, r.lines.length);
      for (let i = 0; i < total; i++) out.write(`\r\x1b[2K${r.lines[i] ?? ''}\n`);
      if (total > r.lines.length) out.write(`\x1b[${total - r.lines.length}A`);
      drawn = r.lines.length;
    }
    function finish(value) {
      input.off('keypress', onKey);
      process.off('SIGWINCH', draw);
      input.setRawMode(wasRaw);
      input.pause();
      if (drawn) out.write(`\x1b[${drawn}A`);
      for (let i = 0; i < drawn; i++) out.write('\r\x1b[2K\n');
      if (drawn) out.write(`\x1b[${drawn}A`);
      out.write('\x1b[?25h');
      resolve(value);
    }
    function onKey(str, key = {}) {
      const page = pageSize();
      if ((key.ctrl && (key.name === 'c' || key.name === 'd')) || key.name === 'escape') return finish(null);
      if (key.name === 'return' || key.name === 'enter') { if (shown[selected]) finish(shown[selected].value); return; }
      if (key.name === 'down' || (key.ctrl && key.name === 'n') || key.name === 'tab') selected = Math.min(selected + 1, shown.length - 1);
      else if (key.name === 'up' || (key.ctrl && key.name === 'p')) selected = Math.max(selected - 1, 0);
      else if (key.name === 'pagedown') selected = Math.min(selected + page, shown.length - 1);
      else if (key.name === 'pageup') selected = Math.max(selected - page, 0);
      else if (key.name === 'home') selected = 0;
      else if (key.name === 'end') selected = shown.length - 1;
      else if (key.name === 'backspace') { query = [...query].slice(0, -1).join(''); selected = 0; }
      else if (key.ctrl && key.name === 'u') { query = ''; selected = 0; }
      else if (str && !key.ctrl && !key.meta && [...str].every((ch) => ch >= ' ' && ch !== '\x7f')) { query += str; selected = 0; }
      draw();
    }
    input.on('keypress', onKey);
    process.on('SIGWINCH', draw);
    draw();
  });
}
