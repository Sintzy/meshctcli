// Device model: normalisation of MeshCentral "nodes", OS detection and name matching.
import { MeshError, EXIT } from '../errors.js';

// Agent architecture ids, as used by the MeshCentral web UI (views/default.handlebars).
const WINDOWS_AGENT_IDS = new Set([1, 2, 3, 4, 21, 22, 34, 42, 43]);
const MACOS_AGENT_IDS = new Set([11, 16, 29, 10005]);
const ANDROID_AGENT_IDS = new Set([14]);

// node.conn bit flags
export const CONN = Object.freeze({ agent: 1, cira: 2, amt: 4, relay: 8, mqtt: 16 });
// node.agent.caps bit flags
export const CAPS = Object.freeze({ desktop: 1, terminal: 2, files: 4, console: 8, js: 16 });
// node.pwr states
const POWER = { 0: 'unknown', 1: 'on', 2: 'sleep', 3: 'sleep', 4: 'sleep', 5: 'off', 6: 'hibernate', 7: 'soft-off', 8: 'present', 9: 'off' };

export const OS_LABEL = { windows: 'Windows', linux: 'Linux', macos: 'macOS', freebsd: 'FreeBSD', android: 'Android', unknown: 'Unknown' };

export function detectOs(node) {
  // The agent architecture id is authoritative: "Microsoft Hyper-V Server" and some Server SKUs
  // report an OS description that does not contain the word "Windows".
  const id = Number(node.agent?.id);
  if (WINDOWS_AGENT_IDS.has(id)) return 'windows';
  if (MACOS_AGENT_IDS.has(id)) return 'macos';
  if (ANDROID_AGENT_IDS.has(id)) return 'android';
  const desc = String(node.osdesc || '').toLowerCase();
  if (desc.includes('windows') || desc.includes('microsoft')) return 'windows';
  if (desc.includes('mac os') || desc.includes('macos') || desc.includes('os x') || desc.includes('darwin')) return 'macos';
  if (desc.includes('freebsd')) return 'freebsd';
  if (desc.includes('android')) return 'android';
  if (desc) return 'linux'; // the agent reports distro names ("Ubuntu 24.04", "Debian GNU/Linux 12", ...)
  if (Number.isFinite(id) && id > 4) return 'linux';
  return 'unknown';
}

/** Flatten the {meshid: [node]} structure into normalised device objects. */
export function normalizeDevices({ meshes = [], nodes = {} }) {
  const groups = new Map((Array.isArray(meshes) ? meshes : Object.values(meshes)).map((m) => [m._id, m]));
  const devices = [];
  for (const [meshId, list] of Object.entries(nodes)) {
    for (const n of list || []) devices.push(normalizeDevice(n, groups.get(meshId), meshId));
  }
  return devices.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

export function normalizeDevice(n, mesh, meshId = n.meshid) {
  const conn = Number(n.conn || 0);
  return {
    id: n._id,
    name: String(n.name || n.rname || n.host || n._id || '?').trim(),
    host: n.host || null,
    group: mesh?.name || null,
    groupId: meshId || null,
    os: detectOs(n),
    osDesc: n.osdesc || null,
    online: (conn & CONN.agent) !== 0,
    conn,
    power: POWER[n.pwr] || 'unknown',
    agentId: n.agent?.id ?? null,
    agentVersion: n.agent?.ver ?? null,
    caps: Number(n.agent?.caps || 0),
    ip: n.ip || null,
    users: Array.isArray(n.users) ? n.users : [],
    tags: Array.isArray(n.tags) ? n.tags : [],
    description: n.desc || null,
    meshType: mesh?.mtype ?? null, // 1 = Intel AMT only, 2 = agent, 3 = local (no agent)
    rdpPort: n.rdpport || 3389,
    lastConnect: n.lastconnect || null,
  };
}

export const can = (device, cap) => (device.caps & CAPS[cap]) !== 0;

const fold = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();

/**
 * Find devices for a user query. Order: id match, exact name, name prefix, substring.
 * Case- and accent-insensitive. Returns every candidate at the best level that matched.
 */
export function matchDevices(devices, query) {
  const raw = String(query ?? '').trim();
  if (!raw) return { level: 'all', matches: devices };
  if (/^node\//.test(raw) || raw.startsWith('id:')) {
    const id = raw.replace(/^id:/, '');
    const m = devices.filter((d) => d.id === id || d.id.endsWith(`/${id}`));
    return { level: 'id', matches: m };
  }
  const q = fold(raw);
  const exact = devices.filter((d) => fold(d.name) === q);
  if (exact.length) return { level: 'exact', matches: exact };
  const prefix = devices.filter((d) => fold(d.name).startsWith(q));
  if (prefix.length) return { level: 'prefix', matches: prefix };
  const contains = devices.filter((d) => fold(d.name).includes(q) || (d.host && fold(d.host).includes(q)));
  return { level: 'contains', matches: contains };
}

/** Filters for "mesh list": --os, --group, --online/--offline, free text. */
export function filterDevices(devices, { os, group, online, text } = {}) {
  return devices.filter((d) => {
    if (os && d.os !== os) return false;
    if (group && !fold(d.group || '').includes(fold(group))) return false;
    if (online === true && !d.online) return false;
    if (online === false && d.online) return false;
    if (text && !matchDevices([d], text).matches.length) return false;
    return true;
  });
}

export function deviceNotFound(query, devices) {
  const names = devices.slice(0, 8).map((d) => d.name);
  return new MeshError(`No device matches "${query}".`, {
    exitCode: EXIT.NOT_FOUND,
    hint: names.length ? `Run "mesh list" to see all devices (e.g. ${names.join(', ')}).` : 'No devices are visible to this account.',
  });
}

export function ambiguous(query, matches) {
  return new MeshError(`"${query}" matches ${matches.length} devices.`, {
    exitCode: EXIT.NOT_FOUND,
    details: matches.slice(0, 10).map((d) => `${d.name}${d.group ? `  (${d.group})` : ''}  ${d.id}`),
    hint: 'Use the full name, or "id:<node id>" to pick one explicitly.',
  });
}

export function describeDevice(d) {
  return `${OS_LABEL[d.os]} ${d.online ? 'online' : 'offline'}`;
}
