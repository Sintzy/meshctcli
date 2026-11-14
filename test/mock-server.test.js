// Protocol tests against an in-process MOCK MeshCentral server (simulated, see helpers.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startMockServer, tempConfigDir } from './helpers.js';
import { MeshClient } from '../src/mesh/client.js';
import { normalizeDevices } from '../src/mesh/devices.js';
import { openRelay } from '../src/mesh/relay.js';
import { FileSession } from '../src/session/files.js';
import { startTunnel } from '../src/session/tunnel.js';
import { AuthError } from '../src/errors.js';

let mock;
let cfg;
before(async () => { cfg = tempConfigDir(); mock = await startMockServer({ users: { admin: 'secret', mfa: 'pw' }, files: { '/data/report.bin': Buffer.alloc(16380 * 3 + 7, 7) } }); });
after(async () => { await mock.close(); cfg.cleanup(); });

const connect = (user = 'admin', password = 'secret', token) => MeshClient.connect({ profile: mock.profile, auth: { user, password, token }, timeout: 3000 });

test('login sends credentials only in the x-meshauth header', async () => {
  const c = await connect();
  assert.equal(c.userInfo.name, 'admin');
  const header = mock.state.headers.at(-1).split(',').map((x) => Buffer.from(x, 'base64').toString());
  assert.deepEqual(header, ['admin', 'secret']);
  c.close();
});

test('wrong password -> AuthError(invalid)', async () => {
  await assert.rejects(connect('admin', 'nope'), (e) => e instanceof AuthError && e.reason === 'invalid');
});

test('two-factor required -> AuthError(tokenrequired), then token accepted', async () => {
  const m2 = await startMockServer({ users: { mfa: 'pw' }, otp: '123456' });
  try {
    await assert.rejects(MeshClient.connect({ profile: m2.profile, auth: { user: 'mfa', password: 'pw' } }), (e) => e.reason === 'tokenrequired');
    const c = await MeshClient.connect({ profile: m2.profile, auth: { user: 'mfa', password: 'pw', token: '123456' } });
    assert.equal(c.userInfo.name, 'mfa');
    c.close();
  } finally { await m2.close(); }
});

test('device list, run command, login cookie, login token', async () => {
  const c = await connect();
  const devices = normalizeDevices(await c.listDevices());
  assert.deepEqual(devices.map((d) => `${d.name}:${d.os}:${d.online}:${d.group}`), ['Lenovo3:windows:true:Office', 'ubuntu26:linux:false:Office']);
  assert.equal(await c.runCommand('node//win1', 'whoami', { type: 2 }), 'ran(2): whoami');
  await assert.rejects(c.runCommand('node//lin1', 'x'), /Agent not connected/);
  assert.equal(await c.loginCookie(), 'L0GIN');
  const tok = await c.createLoginToken({ name: 'MeshctCLI test', expireMinutes: 60 });
  assert.equal(tok.user, '~t:abc');
  assert.ok(tok.expire > 0);
  c.close();
  const viaToken = await connect('~t:abc', 'tokpass');
  assert.equal(viaToken.userInfo.name, '~t:abc');
  viaToken.close();
});

test('login cookie unsupported -> null after short timeout (server stays silent)', async () => {
  const m2 = await startMockServer({ loginCookie: false });
  try {
    const c = await MeshClient.connect({ profile: m2.profile, auth: { user: 'admin', password: 'secret' } });
    assert.equal(await c.loginCookie({ timeout: 300 }), null);
    c.close();
  } finally { await m2.close(); }
});

test('relay tunnel asks the agent with rauth and opens the browser side with auth', async () => {
  const c = await connect();
  const { ws } = await openRelay(c, { nodeId: 'node//win1', protocol: 6, options: { cols: 80, rows: 24 } });
  const msg = mock.state.agentMsgs.at(-1);
  assert.equal(msg.nodeid, 'node//win1');
  assert.match(msg.value, /^\*\/meshrelay\.ashx\?p=6&nodeid=node%2F%2Fwin1&id=[0-9a-f]+&rauth=RC00KIE$/);
  const prompt = await new Promise((r) => ws.once('message', (d) => r(d.toString())));
  assert.equal(prompt, 'PS 6> ');
  ws.close();
  c.close();
});

test('file session: ls, upload (with escaping), download (multi-block), errors', async () => {
  const c = await connect();
  const device = { id: 'node//lin1', name: 'ubuntu26', os: 'linux' };
  const fsn = await FileSession.open(c, device);
  const list = await fsn.ls('/data');
  assert.deepEqual(list.map((e) => [e.name, e.type, e.size]), [['report.bin', 'file', 16380 * 3 + 7]]);
  assert.equal(await fsn.ls('/missing'), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshcli-xfer-'));
  const local = path.join(dir, 'up.bin');
  const payload = Buffer.concat([Buffer.from('{json-looking start'), Buffer.alloc(200000, 1), Buffer.from([0, 0, 0])]);
  fs.writeFileSync(local, payload);
  const progress = [];
  const sent = await fsn.upload(local, '/tmp', 'up.bin', { onProgress: (b) => progress.push(b) });
  assert.equal(sent, payload.length);
  assert.ok(mock.state.files['/tmp/up.bin'].equals(payload), 'uploaded bytes are identical');
  assert.equal(progress.at(-1), payload.length);
  assert.ok(progress.every((v, i) => i === 0 || v >= progress[i - 1]), 'progress is monotonic');

  await assert.rejects(fsn.upload(local, '/readonly', 'x.bin'), /could not write/);

  const dest = path.join(dir, 'report.bin');
  const got = await fsn.download('/data/report.bin', dest);
  assert.equal(got, 16380 * 3 + 7);
  assert.ok(fs.readFileSync(dest).equals(mock.state.files['/data/report.bin']));
  assert.ok(!fs.existsSync(`${dest}.part`));

  await assert.rejects(fsn.download('/data/nope.bin', path.join(dir, 'nope.bin')), /refused to read/);
  assert.ok(!fs.existsSync(path.join(dir, 'nope.bin.part')), 'partial file removed on failure');
  fsn.close();
  c.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TCP tunnel forwards bytes both ways', async () => {
  const c = await connect();
  const tun = await startTunnel(c, { id: 'node//win1', name: 'Lenovo3' }, { remotePort: 3389 });
  const echoed = await new Promise((resolve, reject) => {
    const sock = net.connect(tun.port, '127.0.0.1', () => sock.write('ping-through-tunnel'));
    sock.once('data', (d) => { resolve(d.toString()); sock.destroy(); });
    sock.on('error', reject);
  });
  assert.equal(echoed, 'ping-through-tunnel');
  tun.close();
  c.close();
});
