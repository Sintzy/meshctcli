// Browser discovery and launching, with Chromium "app mode" windows (no tabs, no address bar).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { paths, ensurePrivateDir } from '../config/paths.js';
import { MeshError } from '../errors.js';

export const BROWSERS = ['chrome', 'edge', 'chromium', 'brave', 'firefox', 'default', 'custom'];
const APP_MODE = new Set(['chrome', 'edge', 'chromium', 'brave', 'custom']);

function candidates(kind, platform = process.platform, env = process.env) {
  const home = os.homedir();
  if (platform === 'darwin') {
    const app = {
      chrome: 'Google Chrome.app/Contents/MacOS/Google Chrome',
      edge: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      chromium: 'Chromium.app/Contents/MacOS/Chromium',
      brave: 'Brave Browser.app/Contents/MacOS/Brave Browser',
      firefox: 'Firefox.app/Contents/MacOS/firefox',
    }[kind];
    return app ? [path.join('/Applications', app), path.join(home, 'Applications', app)] : [];
  }
  if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.ProgramW6432].filter(Boolean);
    const rel = {
      chrome: 'Google\\Chrome\\Application\\chrome.exe',
      edge: 'Microsoft\\Edge\\Application\\msedge.exe',
      chromium: 'Chromium\\Application\\chrome.exe',
      brave: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      firefox: 'Mozilla Firefox\\firefox.exe',
    }[kind];
    return rel ? roots.map((r) => path.win32.join(r, rel)) : [];
  }
  const names = {
    chrome: ['google-chrome-stable', 'google-chrome'],
    edge: ['microsoft-edge-stable', 'microsoft-edge'],
    chromium: ['chromium', 'chromium-browser'],
    brave: ['brave-browser', 'brave'],
    firefox: ['firefox'],
  }[kind] || [];
  return names.map((n) => ({ command: n }));
}

function which(command) {
  const r = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Locate a browser executable. Returns { kind, path } or null. */
export function findBrowser(kind, { browserPath } = {}) {
  if (browserPath) return fs.existsSync(browserPath) ? { kind: kind === 'default' ? 'custom' : kind, path: browserPath } : null;
  if (kind === 'default' || kind === 'custom') return null;
  for (const c of candidates(kind)) {
    if (typeof c === 'string') { if (fs.existsSync(c)) return { kind, path: c }; }
    else { const p = which(c.command); if (p) return { kind, path: p }; }
  }
  return null;
}

/** All installed browsers we know about (for "mesh configure" and "mesh doctor"). */
export function installedBrowsers() {
  return ['chrome', 'edge', 'chromium', 'brave', 'firefox'].map((k) => findBrowser(k)).filter(Boolean);
}

/** Arguments for a dedicated app-mode window. A separate profile keeps the MeshCentral session isolated and persistent. */
export function appModeArgs(url, { profileDir = paths.browserProfile, width = 1440, height = 900 } = {}) {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI',
    '--class=MeshctCLI',
  ];
}

/**
 * Write a self-deleting local page that redirects to the real URL. Used when the URL contains
 * a login cookie, so the cookie never appears in the browser's command line (ps / Task Manager).
 */
export function writeRedirectPage(url) {
  const dir = path.join(paths.config, 'tmp');
  ensurePrivateDir(dir);
  // Remove leftovers from earlier runs (e.g. if the process was killed before cleanup).
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    try { if (Date.now() - fs.statSync(full).mtimeMs > 60000) fs.unlinkSync(full); } catch { /* ignore */ }
  }
  const file = path.join(dir, `open-${process.pid}-${Date.now()}.html`);
  const safe = JSON.stringify(url).replace(/</g, '\\u003c');
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>MeshctCLI</title><meta name="referrer" content="no-referrer"><script>location.replace(${safe});</script>`, { mode: 0o600 });
  return { url: pathToFileURL(file).toString(), file, cleanup: () => { try { fs.unlinkSync(file); } catch { /* ignore */ } } };
}

function launch(executable, args) {
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
  return new Promise((resolve, reject) => {
    child.once('error', (err) => reject(new MeshError(`Cannot start ${executable}: ${err.message}`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/** Open a URL in the system default browser (no shell involved, so "&" in URLs is safe). */
export function openDefault(url) {
  if (process.platform === 'darwin') return launch('open', [url]);
  if (process.platform === 'win32') return launch('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  return launch('xdg-open', [url]);
}

/**
 * Open url according to the profile's browser preference.
 * @returns {Promise<{ mode: 'app'|'window'|'default', browser: string }>}
 */
export async function openInBrowser(url, { browser = 'chrome', browserPath, appMode = true, sensitive = false } = {}) {
  let target = url;
  let redirect = null;
  if (sensitive) { redirect = writeRedirectPage(url); target = redirect.url; }
  const found = browser === 'default' && !browserPath ? null : findBrowser(browser, { browserPath });
  if (found && appMode && APP_MODE.has(found.kind)) {
    ensurePrivateDir(paths.browserProfile);
    await launch(found.path, appModeArgs(target));
    return { mode: 'app', browser: found.kind, redirect };
  }
  if (found && found.kind === 'firefox') {
    await launch(found.path, ['--new-window', target]);
    return { mode: 'window', browser: 'firefox', redirect };
  }
  if (browser !== 'default' && !found && browser !== 'custom') {
    // Requested browser not installed: fall back to the default browser, but say so.
    await openDefault(target);
    return { mode: 'default', browser: 'default', missing: browser, redirect };
  }
  await openDefault(target);
  return { mode: 'default', browser: 'default', redirect };
}
