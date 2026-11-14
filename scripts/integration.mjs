#!/usr/bin/env node
// Integration checks against a REAL MeshCentral server, using your configured profile and stored login.
//
//   node scripts/integration.mjs <device> [--profile name] [--write] [--remote-dir PATH]
//
// Read-only by default (status, list, info, run, file listing, relay). With --write it also uploads a
// small random file to --remote-dir (default: C:\Windows\Temp or /tmp), downloads it back, compares the
// bytes and deletes the remote copy. Nothing destructive (power, messages) is ever run.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(root, 'bin', 'mesh.js');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const device = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--profile' && argv[i - 1] !== '--remote-dir');
if (!device) { console.error('Usage: node scripts/integration.mjs <device> [--profile name] [--write] [--remote-dir PATH]'); process.exit(2); }
const profileArgs = value('--profile') ? ['--profile', value('--profile')] : [];

const results = [];
function mesh(args, { input } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [BIN, ...profileArgs, ...args], { encoding: 'utf8', input, env: { ...process.env, NO_COLOR: '1' }, timeout: 180000 });
  return { ...r, ms: Date.now() - started };
}
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    console.log(`  OK    ${name}${detail ? `  (${detail})` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(` FAIL   ${name}  ${err.message}`);
  }
}
const must = (r, what) => { if (r.status !== 0) throw new Error(`${what} exited ${r.status}: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`); return r; };

console.log(`MeshCLI integration test (REAL server) - device "${device}"\n`);
{
  const pre = mesh(['status', '--offline']);
  if (pre.status !== 0 || /Not logged in/.test(pre.stdout)) {
    console.error(`${(pre.stderr || pre.stdout).trim()}\n\nSet MeshCLI up first (same terminal, same user):\n  mesh configure\n  mesh login`);
    console.error('\nNote: if "mesh" still prints Portuguese text, your shell is running the old prototype function; open a new terminal.');
    process.exit(2);
  }
}
let info = null;
check('status: connected', () => { const r = must(mesh(['status', '--json']), 'status'); const s = JSON.parse(r.stdout); if (!s.connected) throw new Error(s.error || 'not connected'); return `${s.serverUser}@${s.server}`; });
check('list --json', () => { const r = must(mesh(['list', '--json']), 'list'); const d = JSON.parse(r.stdout); return `${d.length} devices, ${d.filter((x) => x.online).length} online, ${r.ms} ms`; });
check('info --json', () => { const r = must(mesh(['info', device, '--json']), 'info'); info = JSON.parse(r.stdout); if (!info.online) throw new Error(`${info.name} is offline`); return `${info.name}, ${info.osDesc}`; });
const windows = info?.os === 'windows';
check('run whoami', () => { const r = must(mesh(['run', device, 'whoami']), 'run'); return r.stdout.trim(); });
if (windows) check('run (cmd) ver', () => must(mesh(['run', device, 'ver', '--cmd']), 'run --cmd').stdout.trim().split('\n').pop());
check('files --list (relay tunnel)', () => { const r = must(mesh(['files', device, windows ? 'C:\\' : '/', '--json']), 'files'); return `${JSON.parse(r.stdout).length} entries, ${r.ms} ms`; });
check('shell (piped, non-interactive)', () => {
  const r = must(mesh(['shell', device], { input: windows ? 'Write-Output "MESHCLI-$((6*7))"\r\nexit\r\n' : 'echo MESHCLI-$((6*7)); exit\n' }), 'shell');
  if (!r.stdout.includes('MESHCLI-42')) throw new Error('marker not echoed');
  return 'marker echoed';
});
check('web --print-url (signed-in desktop URL)', () => { const r = must(mesh(['web', device, '--print-url']), 'web'); const u = new URL(r.stdout.trim().split('\n').pop()); return `viewmode=${u.searchParams.get('viewmode')}, login cookie ${u.searchParams.has('login') ? 'yes' : 'no (allowLoginToken off)'}`; });

if (flag('--write')) {
  const remoteDir = value('--remote-dir') || (windows ? 'C:\\Windows\\Temp' : '/tmp');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meshcli-it-'));
  const name = `meshcli-it-${crypto.randomBytes(4).toString('hex')}.bin`;
  const local = path.join(tmp, name);
  const payload = crypto.randomBytes(3 * 1024 * 1024 + 123);
  fs.writeFileSync(local, payload);
  const remoteFile = windows ? `${remoteDir.replace(/\\$/, '')}\\${name}` : `${remoteDir.replace(/\/$/, '')}/${name}`;
  check(`upload 3 MB to ${remoteDir}`, () => `${must(mesh(['upload', device, local, remoteDir]), 'upload').ms} ms`);
  const uploaded = results.at(-1).ok;
  if (uploaded) check('download and compare', () => {
    const back = path.join(tmp, 'back.bin');
    must(mesh(['download', device, remoteFile, back]), 'download');
    if (!fs.readFileSync(back).equals(payload)) throw new Error('downloaded bytes differ');
    return 'identical';
  });
  if (uploaded) check('overwrite protection', () => { const r = mesh(['upload', device, local, remoteDir], { input: '' }); if (r.status === 0) throw new Error('overwrote without --force'); return `refused (exit ${r.status})`; });
  if (uploaded) check('cleanup remote file', () => { must(mesh(['run', device, windows ? `Remove-Item -LiteralPath '${remoteFile}'` : `rm -f '${remoteFile}'`]), 'cleanup'); return 'removed'; });
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
const outDir = path.join(root, 'test-results');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `integration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify({ kind: 'REAL server integration', date: new Date().toISOString(), device, results }, null, 2));
console.log(`\n${failed ? ` FAIL   ${failed} of ${results.length} checks failed.` : `  OK    All ${results.length} checks passed.`}\nResults saved to ${file}`);
process.exit(failed ? 1 : 0);
