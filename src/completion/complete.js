// Context-aware completion engine. Shell scripts call "mesh __complete <cword> <words...>" and
// get one candidate per line. A first line of ":files" asks the shell for path completion.
// Device names come from the local cache only: pressing Tab never opens a network connection.

/** What each argument slot of a command completes to. "files*" = files for this and every later slot. */
export const ARG_KINDS = {
  shell: ['device'], ps: ['device'], cmd: ['device'], run: ['device'], info: ['device'], web: ['device'], desktop: ['device'],
  rdp: ['device'], tunnel: ['device'], relay: ['device', ['http', 'https']], files: ['device'], explore: ['device'],
  upload: ['device', 'files*'], put: ['device', 'files*'], download: ['device', 'none', 'files'], get: ['device', 'none', 'files'],
  toast: ['device'], message: ['device'], open: ['device'], restart: ['device'], reboot: ['device'], shutdown: ['device'],
  sleep: ['device'], wake: ['device'], list: ['device'], ls: ['device'], profile: [['list', 'use', 'remove'], 'profile'],
  completion: [['zsh', 'bash', 'fish', 'powershell', 'install', 'uninstall'], ['zsh', 'bash', 'fish', 'powershell']],
  help: ['command'],
};

const VALUE_OPTIONS = new Set(['-p', '--profile', '--timeout', '--group', '--os', '--panel', '--title', '--port', '--local-port', '--remote-host', '--bind', '--url', '--user', '--browser', '--shell', '--expire-days', '--ca', '--trust-fingerprint', '--browser-path', '--timeout-cmd']);

const unquote = (w) => String(w ?? '').replace(/^["']/, '').replace(/["']$/, '').replace(/\\(.)/g, '$1');

function filterPrefix(candidates, current) {
  const cur = unquote(current).toLocaleLowerCase();
  if (!cur) return candidates;
  const prefix = candidates.filter((c) => c.toLocaleLowerCase().startsWith(cur));
  return prefix.length ? prefix : candidates.filter((c) => c.toLocaleLowerCase().includes(cur));
}

/**
 * @param {string[]} words   words after "mesh", including the (possibly empty) word being completed
 * @param {number} cword     1-based index of the word being completed within words
 * @param {{ commands: string[], deviceNames: (profile?:string) => string[], profiles: () => string[] }} data
 * @returns {string[]}
 */
export function complete(words, cword, data) {
  const current = words[cword - 1] ?? '';
  const before = words.slice(0, cword - 1);
  if (current.startsWith('-')) return [];
  // Positional words before the cursor (skip options and their values) + selected profile
  const positionals = [];
  let profile;
  for (let i = 0; i < before.length; i++) {
    const w = before[i];
    if (w === '-p' || w === '--profile') { profile = unquote(before[i + 1]); i++; continue; }
    if (VALUE_OPTIONS.has(w)) { i++; continue; }
    if (w.startsWith('-')) continue;
    positionals.push(unquote(w));
  }
  const prev = before[before.length - 1];
  if (prev === '-p' || prev === '--profile') return filterPrefix(data.profiles(), current);
  if (prev === '--os') return filterPrefix(['windows', 'linux', 'macos', 'freebsd', 'android'], current);
  if (prev === '--panel') return filterPrefix(['desktop', 'terminal', 'files', 'general', 'events', 'console'], current);
  if (prev === '--browser') return filterPrefix(['chrome', 'edge', 'chromium', 'brave', 'firefox', 'default', 'custom'], current);
  if (prev === '--shell') return filterPrefix(['auto', 'powershell', 'cmd', 'sh'], current);
  if (VALUE_OPTIONS.has(prev)) return [];

  const devices = () => data.deviceNames(profile);
  if (positionals.length === 0) {
    // First word: a command or a device name ("mesh Lenovo3" opens a shell).
    return filterPrefix([...data.commands, ...devices()], current);
  }
  const command = positionals[0];
  const kinds = ARG_KINDS[command];
  if (!kinds) return []; // first word was a device name: nothing else to complete
  const slot = positionals.length - 1;
  let kind = kinds[slot];
  if (kind === undefined) { const last = kinds[kinds.length - 1]; kind = last === 'files*' ? 'files*' : undefined; }
  if (Array.isArray(kind)) return filterPrefix(kind, current);
  if (kind === 'device') return filterPrefix(devices(), current);
  if (kind === 'profile') return filterPrefix(data.profiles(), current);
  if (kind === 'command') return filterPrefix(data.commands, current);
  if (kind === 'files' || kind === 'files*') return [':files'];
  return [];
}
