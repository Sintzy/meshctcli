// MeshCentral URL handling: user input -> canonical https base URL -> control/relay/web URLs.
import { UsageError } from '../errors.js';

/**
 * Normalise what the user typed into a canonical server description.
 * Accepts "host", "host:port", "https://host:port/domain/", "wss://host/control.ashx?key=abc".
 * @returns {{ base: string, loginKey: string|null }}  base always ends with "/" and uses https: or http:
 */
export function normalizeServerUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new UsageError('Server URL is empty.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try { url = new URL(raw); } catch { throw new UsageError(`Invalid server URL: ${input}`); }
  const proto = url.protocol.toLowerCase();
  if (proto === 'wss:') url.protocol = 'https:';
  else if (proto === 'ws:') url.protocol = 'http:';
  else if (proto !== 'https:' && proto !== 'http:') throw new UsageError(`Unsupported URL scheme "${proto}". Use https://.`);
  if (url.username || url.password) throw new UsageError('Do not put credentials in the server URL. Use "mesh login".');
  const loginKey = url.searchParams.get('key');
  url.search = '';
  url.hash = '';
  let pathname = url.pathname.replace(/\/(control|meshrelay)\.ashx$/i, '/');
  if (!pathname.endsWith('/')) pathname += '/';
  url.pathname = pathname;
  return { base: url.toString(), loginKey: loginKey || null };
}

export function hostLabel(base) {
  const url = new URL(base);
  return url.host + (url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '');
}

function withKey(url, loginKey) {
  if (loginKey) url.searchParams.set('key', loginKey);
  return url;
}

/** wss://host:port/domain/control.ashx[?key=] */
export function controlUrl({ base, loginKey }) {
  const url = new URL('control.ashx', base);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return withKey(url, loginKey).toString();
}

/** wss://host:port/domain/meshrelay.ashx?<query> */
export function relayUrl({ base, loginKey }, query) {
  const url = new URL('meshrelay.ashx', base);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  return withKey(url, loginKey).toString();
}

/** Path part used by the agent for the relay ("*" prefix means "same server"). */
export function agentRelayPath({ base }, query) {
  const url = new URL('meshrelay.ashx', base);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) params.set(k, String(v));
  return `*${url.pathname}?${params.toString()}`;
}

// View modes used by the MeshCentral web UI (views/default.handlebars).
export const VIEW = Object.freeze({ general: 10, desktop: 11, terminal: 12, files: 13, events: 16, console: 17 });

// "hide" bit flags understood by the web UI: 1 header, 2 tab bar, 4 footer, 8 page title, 16 left bar, 32 back button.
export const HIDE = Object.freeze({ header: 1, tabs: 2, footer: 4, title: 8, leftbar: 16, back: 32 });

/**
 * Web UI URL that opens a device directly on a given panel. This is the same form the
 * MeshCentral UI itself uses for "open in new window": ?node=<id>&viewmode=<n>&hide=<flags>.
 */
export function deviceWebUrl({ base, loginKey }, { nodeId, view = VIEW.desktop, hide = 0, login } = {}) {
  const url = new URL(base);
  if (login) url.searchParams.set('login', login);
  if (nodeId) url.searchParams.set('node', shortNodeId(nodeId));
  url.searchParams.set('viewmode', String(view));
  if (hide) url.searchParams.set('hide', String(hide));
  return withKey(url, loginKey).toString();
}

/** "node/domain/abc" -> "abc" */
export function shortNodeId(nodeId) { return String(nodeId).split('/').pop(); }
