// TLS policy, configuration/credential storage and CLI behaviour (subprocess) tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { tempConfigDir } from './helpers.js';
import { MeshClient } from '../src/mesh/client.js';
import { probeCertificate, leafFingerprint } from '../src/mesh/tls.js';
import { loadConfig, saveConfig, resolveProfile, validateProfileName, emptyConfig } from '../src/config/config.js';
import { BACKENDS } from '../src/auth/keyring.js';
import { envCredentials, keyringAccount, resolveCredentials, saveStored } from '../src/auth/credentials.js';
import { writeDeviceCache, completionNames } from '../src/mesh/cache.js';
import { NetworkError } from '../src/errors.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mesh.js');
let cfg;
before(() => { cfg = tempConfigDir(); });
after(() => cfg.cleanup());

function selfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshcli-cert-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')), dir };
}

test('TLS: self-signed rejected by default, accepted when pinned, rejected on pin mismatch', async (t) => {
  const pair = selfSignedCert();
  if (!pair) { t.skip('openssl not available'); return; }
  const server = https.createServer({ key: pair.key, cert: pair.cert });
  const wss = new WebSocketServer({ server });
  const seenHeaders = [];
  wss.on('connection', (ws, req) => {
    seenHeaders.push(req.headers['x-meshauth']);
    ws.send(JSON.stringify({ action: 'serverinfo', serverinfo: {} }));
    ws.send(JSON.stringify({ action: 'userinfo', userinfo: { _id: 'user//a', name: 'a' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `https://localhost:${server.address().port}/`;
  const auth = { user: 'a', password: 'b' };
  try {
    await assert.rejects(MeshClient.connect({ profile: { url: base, tls: {} }, auth }), (e) => e instanceof NetworkError && /not trusted/.test(e.message));
    assert.equal(seenHeaders.length, 0, 'no credentials sent to an untrusted server');
    const probe = await probeCertificate(base);
    assert.equal(probe.authorized, false);
    const fingerprint = leafFingerprint(probe.chain);
    const ok = await MeshClient.connect({ profile: { url: base, tls: { fingerprint } }, auth });
    ok.close();
    assert.equal(seenHeaders.length, 1);
    await assert.rejects(MeshClient.connect({ profile: { url: base, tls: { fingerprint: 'AA:BB:CC' } }, auth }), /does not match the pinned fingerprint/);
    assert.equal(seenHeaders.length, 1, 'no credentials sent when the pin does not match');
  } finally {
    wss.close(); server.close();
    fs.rmSync(pair.dir, { recursive: true, force: true });
  }
});

test('config: save/load, profile resolution, name validation', () => {
  const c = emptyConfig();
  c.profiles.home = { url: 'https://a/', user: 'mm' };
  c.profiles.work = { url: 'https://b/', user: 'x' };
  c.defaultProfile = 'home';
  saveConfig(c);
  const loaded = loadConfig();
  assert.equal(loaded.profiles.home.browser, 'chrome'); // defaults merged
  assert.equal(loaded.profiles.home.tls.insecure, false);
  assert.equal(resolveProfile(loaded, undefined, {}).name, 'home');
  assert.equal(resolveProfile(loaded, 'work', {}).name, 'work');
  assert.equal(resolveProfile(loaded, undefined, { MESHCLI_PROFILE: 'work' }).name, 'work');
  assert.throws(() => resolveProfile(loaded, 'nope', {}), /does not exist/);
  assert.throws(() => validateProfileName('../x'), /Invalid profile name/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(cfg.dir, 'config.json')).mode & 0o777, 0o600);
});

test('credentials: env override, file backend round trip, expiry', () => {
  const profile = { url: 'https://mesh.example.com:444/', user: 'mm', credentialStore: 'file', tls: {} };
  assert.equal(keyringAccount('home', profile), 'home@mesh.example.com:444');
  assert.deepEqual(envCredentials(profile, { MESHCLI_PASSWORD: 'p' }), { source: 'environment', user: 'mm', password: 'p', token: undefined });
  assert.deepEqual(envCredentials(profile, { MESHCTRL_LOGINPASS: 'q', MESHCLI_USER: 'z' }).user, 'z');
  assert.equal(envCredentials(profile, {}), null);

  const saved = { ...process.env };
  delete process.env.MESHCLI_PASSWORD; delete process.env.MESHCTRL_LOGINPASS;
  try {
    saveStored('home', profile, { kind: 'token', user: '~t:1', secret: 's3cr3t', owner: 'mm', expire: 0 }, BACKENDS.file);
    const raw = fs.readFileSync(path.join(cfg.dir, 'credentials.json'), 'utf8');
    assert.ok(!raw.includes('s3cr3t'), 'secret is not stored verbatim (base64 wrapped)');
    const creds = resolveCredentials('home', profile);
    assert.equal(creds.source, 'login token');
    assert.equal(creds.password, 's3cr3t');
    saveStored('home', profile, { kind: 'token', user: '~t:1', secret: 'x', expire: Date.now() - 1000 }, BACKENDS.file);
    assert.throws(() => resolveCredentials('home', profile), /expired/);
    assert.equal(BACKENDS.file.delete('home@mesh.example.com:444'), true);
    assert.equal(resolveCredentials('home', profile), null);
  } finally { Object.assign(process.env, saved); }
});

function mesh(args, { env = {}, input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input, env: { ...process.env, MESHCLI_CONFIG_DIR: cfg.dir, NO_COLOR: '1', ...env } });
}

test('CLI: help, version, usage errors and exit codes', () => {
  const help = mesh(['help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /mesh <device>/);
  assert.match(mesh(['--version']).stdout, /^MeshCLI \d+\.\d+\.\d+/);
  const bad = mesh(['list', '--nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /FAIL +Unknown option '--nope'\./);
  const helpCmd = mesh(['upload', '--help']);
  assert.match(helpCmd.stdout, /mesh upload <device> <local-file>/);
});

test('CLI: completion uses the cache only (no network)', () => {
  const c = emptyConfig();
  c.profiles.home = { url: 'https://10.255.255.1:9/', user: 'mm' }; // unroutable: any network use would hang/fail
  c.defaultProfile = 'home';
  saveConfig(c);
  writeDeviceCache('home', c.profiles.home.url, [{ id: '1', name: 'Lenovo3', online: true }, { id: '2', name: 'Lenovo4', online: false }, { id: '3', name: 'My Laptop' }]);
  assert.deepEqual(completionNames('home'), ['Lenovo3', 'Lenovo4', 'My Laptop']);
  const started = Date.now();
  const r = mesh(['__complete', '2', 'web', 'len']);
  assert.equal(r.stdout, 'Lenovo3\nLenovo4\n');
  assert.ok(Date.now() - started < 3000);
  assert.equal(mesh(['__complete', '3', 'upload', 'Lenovo3', '']).stdout, ':files\n');
  assert.match(mesh(['completion', 'zsh']).stdout, /compdef _meshcli_complete mesh meshcli/);
  assert.match(mesh(['completion', 'powershell']).stdout, /Register-ArgumentCompleter -Native/);
});

test('CLI: not logged in, non-interactive -> auth exit code 3 without prompting', () => {
  const r = mesh(['status', '--offline']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Not logged in/);
  const c = emptyConfig();
  c.profiles.home = { url: 'https://127.0.0.1:9/', user: 'mm', credentialStore: 'file' };
  c.defaultProfile = 'home';
  saveConfig(c);
  const l = mesh(['list'], { input: '' });
  assert.equal(l.status, 3);
  assert.match(l.stderr, /Not logged in/);
});
