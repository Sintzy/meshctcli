// Pure formatting helpers (no I/O), shared by the UI and tests.

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(text) { return String(text).replace(ANSI_RE, ''); }

/** Visible width of a string: ANSI codes removed, wide (CJK/emoji) characters count double. */
export function visibleWidth(text) {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const cp = ch.codePointAt(0);
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) continue;
    if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue; // combining / joiners
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd);
}

export function padEnd(text, width) {
  const gap = width - visibleWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

/** Truncate to a visible width, adding an ellipsis. Only safe for strings without ANSI codes. */
export function truncate(text, width, ellipsis = '…') {
  const s = String(text);
  if (visibleWidth(s) <= width) return s;
  let out = '';
  for (const ch of s) {
    if (visibleWidth(out + ch) > width - visibleWidth(ellipsis)) break;
    out += ch;
  }
  return out + ellipsis;
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = value;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function formatRelativeTime(timestamp, now = Date.now()) {
  if (!timestamp) return 'never';
  const diff = Math.max(0, (now - timestamp) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}

/** Remove control characters from text that comes from the server before printing it. */
export function sanitize(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, '');
}
