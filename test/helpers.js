// Test helpers: temporary config dir and an in-process mock MeshCentral server (plain ws://).
// The mock implements just enough of control.ashx and meshrelay.ashx to exercise the client;
// results from it are SIMULATED, not a substitute for testing against a real server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';

export function tempConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshcli-test-'));
  process.env.MESHCLI_CONFIG_DIR = dir;
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export const MOCK_NODES = {
  'mesh//g1': [
    { _id: 'node//win1', name: 'Lenovo3', osdesc: 'Microsoft Windows 11 Pro', conn: 1, pwr: 1, agent: { id: 4, caps: 15 } },
    { _id: 'node//lin1', name: 'ubuntu26', osdesc: 'Ubuntu 26.04 LTS', conn: 0, agent: { id: 6, caps: 15 } },
  ],
};

/**
 * Start a mock server.
 * @param {{ users?: Record<string,string>, otp?: string, loginCookie?: boolean, files?: Record<string, Buffer> }} opts
 */
export async function startMockServer({ users = { admin: 'secret' }, otp = null, loginCookie = true, files = {} } = {}) {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const state = { headers: [], relays: new Map(), agentMsgs: [], uploads: {}, files: { ...files } };

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname.endsWith('/control.ashx')) control(ws, req);
      else if (url.pathname.endsWith('/meshrelay.ashx')) relay(ws, url);
      else ws.close();
    });
  });

  function control(ws, req) {
    const header = req.headers['x-meshauth'] || '';
    state.headers.push(header);
    const [u, p, t] = header.split(',').map((x) => Buffer.from(x || '', 'base64').toString());
    const close = (cause, msg, extra = {}) => { ws.send(JSON.stringify({ action: 'close', cause, msg, ...extra })); ws.close(); };
    if (users[u] === undefined || users[u] !== p) return close('noauth', 'noauth');
    if (otp && t !== otp) return close('noauth', 'tokenrequired', { email2fa: false, sms2fa: false });
    ws.send(JSON.stringify({ action: 'serverinfo', serverinfo: { name: 'mock', domain: '' } }));
    ws.send(JSON.stringify({ action: 'userinfo', userinfo: { _id: `user//${u}`, name: u } }));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const reply = (o) => ws.send(JSON.stringify({ ...o, responseid: m.responseid }));
      switch (m.action) {
        case 'meshes': ws.send(JSON.stringify({ action: 'meshes', meshes: [{ _id: 'mesh//g1', name: 'Office', mtype: 2 }] })); break;
        case 'nodes': reply({ action: 'nodes', nodes: MOCK_NODES }); break;
        case 'authcookie': ws.send(JSON.stringify({ action: 'authcookie', cookie: 'C00KIE', rcookie: 'RC00KIE' })); break;
        case 'logincookie': if (loginCookie) ws.send(JSON.stringify({ action: 'logincookie', cookie: 'L0GIN' })); break;
        case 'createLoginToken': ws.send(JSON.stringify({ action: 'createLoginToken', name: m.name, tokenUser: '~t:abc', tokenPass: 'tokpass', created: 1, expire: m.expire ? 1 + m.expire * 60000 : 0 })); users['~t:abc'] = 'tokpass'; break;
        case 'runcommands':
          if (m.nodeids[0] === 'node//lin1') reply({ action: 'runcommands', result: 'Agent not connected' });
          else reply({ action: 'msg', type: 'runcommands', result: `ran(${m.type}): ${m.cmds}` });
          break;
        case 'toast': reply({ action: 'toast', result: 'ok' }); break;
        case 'msg':
          if (m.type === 'tunnel') state.agentMsgs.push(m);
          else reply({ action: 'msg', result: 'OK' });
          break;
        default: break;
      }
    });
  }

  // Relay: emulate the agent side of the files protocol (p=5) and a terminal echo (p=1/6).
  function relay(ws, url) {
    const p = url.searchParams.get('p');
    const tcpport = url.searchParams.get('tcpport');
    if (url.searchParams.get('auth') !== 'C00KIE') { ws.close(); return; }
    setTimeout(() => ws.send('c'), 10);
    let protocol = null;
    let upload = null;
    let download = null;
    ws.on('message', (data, isBinary) => {
      if (tcpport) { ws.send(data, { binary: true }); return; } // TCP echo
      if (protocol === null) {
        const text = data.toString();
        if (text.startsWith('{')) return; // options
        protocol = Number(text);
        if (protocol === 1 || protocol === 6) ws.send(`PS ${protocol}> `);
        return;
      }
      if (protocol === 1 || protocol === 6) { if (!isBinary && data.toString().startsWith('{')) return; ws.send(`echo:${data.toString()}`); if (data.toString().includes('exit')) ws.close(); return; }
      // files protocol
      if (upload && isBinary && data[0] !== 123) {
        const chunk = data[0] === 0 ? data.subarray(1) : data;
        upload.parts.push(Buffer.from(chunk));
        ws.send(Buffer.from(JSON.stringify({ action: 'uploadack', reqid: upload.reqid })));
        return;
      }
      const cmd = JSON.parse(data.toString());
      if (cmd.ctrlChannel) return;
      if (cmd.action === 'ls') {
        const dir = cmd.path;
        const entries = Object.entries(state.files).filter(([f]) => path.posix.dirname(f) === dir).map(([f, b]) => ({ n: path.posix.basename(f), t: 3, s: b.length, d: '2026-01-01T00:00:00Z' }));
        const exists = dir === '/' || Object.keys(state.files).some((f) => f.startsWith(`${dir}/`)) || dir === '/tmp';
        ws.send(Buffer.from(JSON.stringify({ action: 'ls', reqid: cmd.reqid, path: dir, dir: exists ? entries : null })));
      } else if (cmd.action === 'upload') {
        if (cmd.path === '/readonly') { ws.send(Buffer.from(JSON.stringify({ action: 'uploaderror', reqid: cmd.reqid }))); return; }
        upload = { reqid: cmd.reqid, name: path.posix.join(cmd.path, cmd.name), parts: [] };
        ws.send(Buffer.from(JSON.stringify({ action: 'uploadstart', reqid: cmd.reqid })));
      } else if (cmd.action === 'uploaddone') {
        state.files[upload.name] = Buffer.concat(upload.parts);
        ws.send(Buffer.from(JSON.stringify({ action: 'uploaddone', reqid: upload.reqid })));
        upload = null;
      } else if (cmd.action === 'download') {
        if (cmd.sub === 'start') {
          const buf = state.files[cmd.path];
          if (!buf) { ws.send(Buffer.from(JSON.stringify({ action: 'download', sub: 'cancel', id: cmd.id }))); return; }
          download = { id: cmd.id, buf, ptr: 0 };
          ws.send(Buffer.from(JSON.stringify({ action: 'download', sub: 'start', id: cmd.id })));
        } else if (cmd.sub === 'startack' || cmd.sub === 'ack') {
          const n = cmd.sub === 'startack' ? 8 : 1;
          for (let i = 0; i < n && download; i++) {
            const slice = download.buf.subarray(download.ptr, download.ptr + 16380);
            download.ptr += slice.length;
            const last = slice.length < 16380;
            const head = Buffer.alloc(4); head.writeUInt32BE(last ? 0x01000001 : 0x01000000);
            ws.send(Buffer.concat([head, slice]), { binary: true });
            if (last) download = null;
          }
        }
      }
    });
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    profile: { url: `http://127.0.0.1:${port}/`, loginKey: null, tls: {} },
    state,
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => r()); }),
  };
}
