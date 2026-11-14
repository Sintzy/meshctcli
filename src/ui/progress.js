// Spinners and transfer progress bars. Both degrade to plain lines when stderr is not a TTY.
import { c, sym, isUnicode, badge } from './term.js';
import { formatBytes, formatDuration } from './format.js';

const FRAMES_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAMES_ASCII = ['-', '\\', '|', '/'];

export function spinner(text, { stream = process.stderr } = {}) {
  const tty = Boolean(stream.isTTY);
  const frames = isUnicode() ? FRAMES_UNICODE : FRAMES_ASCII;
  let i = 0;
  let current = text;
  let timer = null;
  const render = () => stream.write(`\r\x1b[2K${c.cyan(frames[i++ % frames.length])} ${current}`);
  if (tty) { render(); timer = setInterval(render, 80); timer.unref?.(); }
  return {
    update(next) { current = next; if (tty) render(); },
    stop(kind, finalText) {
      if (timer) clearInterval(timer);
      if (tty) stream.write('\r\x1b[2K');
      if (kind) stream.write(`${badge(kind)} ${finalText ?? current}\n`);
    },
  };
}

/** Run an async function under a spinner. */
export async function withSpinner(text, fn, { done } = {}) {
  const s = spinner(text);
  try {
    const value = await fn(s);
    s.stop(done ? 'ok' : null, done);
    return value;
  } catch (err) {
    s.stop();
    throw err;
  }
}

/**
 * Byte progress for transfers. Shows a percentage only when the total is known; the rate is an
 * exponential moving average and the ETA is derived from it.
 */
export class TransferProgress {
  constructor({ label, total = null, stream = process.stderr, now = () => Date.now() }) {
    this.label = label;
    this.total = Number.isFinite(total) && total >= 0 ? total : null;
    this.stream = stream;
    this.tty = Boolean(stream.isTTY);
    this.now = now;
    this.bytes = 0;
    this.start = now();
    this.lastSample = { t: this.start, bytes: 0 };
    this.rate = 0;
    this.lastRender = 0;
  }

  update(bytes) {
    this.bytes = bytes;
    const t = this.now();
    const dt = (t - this.lastSample.t) / 1000;
    if (dt >= 0.25) {
      const instant = (bytes - this.lastSample.bytes) / dt;
      this.rate = this.rate ? this.rate * 0.7 + instant * 0.3 : instant;
      this.lastSample = { t, bytes };
    }
    if (this.tty && t - this.lastRender >= 100) { this.lastRender = t; this.stream.write(`\r\x1b[2K${this.line()}`); }
  }

  line(width = this.stream.columns || 80) {
    const parts = [];
    const sizes = this.total !== null ? `${formatBytes(this.bytes)} / ${formatBytes(this.total)}` : formatBytes(this.bytes);
    parts.push(sizes);
    if (this.rate > 0) parts.push(`${formatBytes(this.rate)}/s`);
    if (this.total !== null && this.rate > 0 && this.bytes < this.total) parts.push(`ETA ${formatDuration((this.total - this.bytes) / this.rate)}`);
    const info = parts.join(` ${sym.dot} `);
    if (this.total === null || this.total === 0) return `  ${c.cyan(sym.arrow)} ${this.label}  ${c.dim(info)}`;
    const pct = Math.min(1, this.bytes / this.total);
    const barWidth = Math.max(10, Math.min(30, width - 70)); // fixed per terminal width: no jitter while numbers change
    const filled = Math.round(pct * barWidth);
    const bar = c.cyan(sym.barFull.repeat(filled)) + c.dim(sym.barEmpty.repeat(barWidth - filled));
    return `  ${bar} ${String(Math.floor(pct * 100)).padStart(3)}%  ${this.label}  ${c.dim(info)}`;
  }

  finish() {
    if (this.tty) this.stream.write('\r\x1b[2K');
    const seconds = (this.now() - this.start) / 1000;
    return { bytes: this.bytes, seconds, rate: seconds > 0 ? this.bytes / seconds : 0 };
  }
}

export { isUnicode };
