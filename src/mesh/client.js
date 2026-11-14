// WebSocket client for the MeshCentral control channel (control.ashx).
//
// This speaks the same JSON protocol used by the MeshCentral web UI and by the official
// meshctrl.js tool. Differences from meshctrl.js: TLS verification stays on, the password is
// never put in argv, and every request has a timeout.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { controlUrl, hostLabel } from './url.js';
import { tlsOptions, describeNetworkError } from './tls.js';
import { AuthError, MeshError, NetworkError } from '../errors.js';

export const DEFAULT_TIMEOUT = 20000;

/** Value for the x-meshauth header: base64(user),base64(pass)[,base64(token)]. */
export function meshAuthHeader({ user, password, token }) {
  const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
  return [b64(user), b64(password), ...(token ? [b64(token)] : [])].join(',');
}

/** Map a server {action:'close'} message to an AuthError. */
export function closeMessageToError(msg) {
  const cause = msg.cause;
  if (cause === 'noauth' && msg.msg === 'tokenrequired') {
    const sent = msg.email2fasent ? ' A code was sent by email.' : msg.sms2fasent ? ' A code was sent by SMS.' : msg.msg2fasent ? ' A code was sent by message.' : '';
    return new AuthError(`Two-factor authentication code required.${sent}`, { reason: 'tokenrequired', info: msg });
  }
  if (cause === 'noauth' && msg.msg === 'nokey') return new AuthError('Server login key in the URL is missing or invalid.', { reason: 'nokey', hint: 'Add ?key=... to the server URL with "mesh configure".' });
  if (cause === 'noauth') return new AuthError('Invalid username or password.', { reason: 'invalid', hint: 'Run "mesh login" to update your credentials.' });
  if (cause === 'locked') return new AuthError('Account locked. Contact the MeshCentral administrator.', { reason: 'locked' });
  if (cause === 'banned') return new AuthError('Access temporarily blocked after too many failed logins.', { reason: 'banned' });
  if (cause === 'notools') return new AuthError('This account is not allowed to use command line tools.', { reason: 'notools' });
  if (cause === 'emailvalidation') return new AuthError('The account e-mail address must be verified first.', { reason: 'emailvalidation' });
  return new AuthError(`Connection closed by server (${cause || 'unknown'}${msg.msg ? `: ${msg.msg}` : ''}).`, { reason: cause });
}

export class MeshClient extends EventEmitter {
  constructor(ws, { server, profile }) {
    super();
    this.ws = ws;
    this.server = server;       // { base, loginKey }
    this.profile = profile;
    this.serverInfo = null;
    this.userInfo = null;
    this.closed = false;
    this.waiters = new Set();
    ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary));
    ws.on('close', () => this.#onClose());
    ws.on('error', (err) => this.#failAll(describeNetworkError(err, hostLabel(server.base))));
  }

  /**
   * Open and authenticate a control connection.
   * @param {{ profile: object, auth: {user:string,password:string,token?:string}, timeout?: number, WebSocketImpl?: any }} opts
   */
  static connect({ profile, auth, timeout = DEFAULT_TIMEOUT, WebSocketImpl = WebSocket }) {
    const server = { base: profile.url, loginKey: profile.loginKey };
    const host = hostLabel(server.base);
    const url = controlUrl(server);
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocketImpl(url, {
        ...tlsOptions(profile),
        headers: { 'x-meshauth': meshAuthHeader(auth), 'User-Agent': 'MeshCLI' },
        handshakeTimeout: timeout,
        perMessageDeflate: false,
      });
      const timer = setTimeout(() => finish(new NetworkError(`Timed out waiting for ${host} to accept the login.`)), timeout);
      const pending = { serverinfo: null };
      function finish(err, client) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.off?.('message', onMessage);
        if (err) { try { ws.terminate?.(); } catch { /* ignore */ } reject(err); } else resolve(client);
      }
      function onMessage(data) {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.action === 'close') return finish(closeMessageToError(msg));
        if (msg.action === 'serverinfo') pending.serverinfo = msg.serverinfo || {};
        if (msg.action === 'userinfo') {
          const client = new MeshClient(ws, { server, profile });
          client.serverInfo = pending.serverinfo;
          client.userInfo = msg.userinfo || {};
          finish(null, client);
        }
      }
      ws.on('message', onMessage);
      ws.on('unexpected-response', (_req, res) => {
        const code = res.statusCode;
        finish(code === 401 || code === 403
          ? new AuthError(`Server refused the connection (HTTP ${code}).`, { reason: 'invalid' })
          : new NetworkError(`Server answered HTTP ${code} instead of a WebSocket upgrade.`, { hint: 'Check the server URL (and domain path).' }));
      });
      ws.on('error', (err) => finish(describeNetworkError(err, host)));
      ws.on('close', () => finish(new AuthError('Connection closed by the server during login.', { reason: 'invalid', hint: 'Check username/password and that the account may use tools.' })));
    });
  }

  get domain() { return this.userInfo?._id ? this.userInfo._id.split('/')[1] : ''; }
  get userId() { return this.userInfo?._id || null; }

  send(obj) {
    if (this.closed) throw new NetworkError('Connection to the server is closed.');
    this.ws.send(JSON.stringify(obj));
  }

  /** Wait for the first message matching predicate. */
  waitFor(predicate, { timeout = DEFAULT_TIMEOUT, what = 'server response' } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new NetworkError('Connection to the server is closed.'));
      const waiter = {
        predicate,
        resolve: (msg) => { clearTimeout(waiter.timer); this.waiters.delete(waiter); resolve(msg); },
        reject: (err) => { clearTimeout(waiter.timer); this.waiters.delete(waiter); reject(err); },
      };
      waiter.timer = setTimeout(() => waiter.reject(new NetworkError(`Timed out waiting for ${what}.`)), timeout);
      this.waiters.add(waiter);
    });
  }

  /** Send a command and wait for its reply. Unique responseid is added automatically. */
  async request(obj, { match, timeout, what } = {}) {
    const responseid = obj.responseid || `meshcli-${obj.action}-${Math.random().toString(36).slice(2, 10)}`;
    const predicate = match || ((m) => m.responseid === responseid);
    const promise = this.waitFor(predicate, { timeout, what: what || `"${obj.action}" response` });
    this.send({ ...obj, responseid });
    return promise;
  }

  #onMessage(data, isBinary) {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.action === 'close') { this.#failAll(closeMessageToError(msg)); return; }
    this.emit('message', msg);
    for (const w of [...this.waiters]) {
      let ok = false;
      try { ok = w.predicate(msg); } catch { ok = false; }
      if (ok) w.resolve(msg);
    }
  }

  #onClose() {
    this.closed = true;
    this.#failAll(new NetworkError('Connection to the server was closed.'));
    this.emit('close');
  }

  #failAll(err) {
    for (const w of [...this.waiters]) w.reject(err);
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ high level API

  /** Device groups and devices visible to the user. */
  async listDevices({ timeout } = {}) {
    const meshesP = this.waitFor((m) => m.action === 'meshes', { timeout, what: 'device group list' });
    this.send({ action: 'meshes' });
    const nodesMsg = await this.request({ action: 'nodes' }, { match: (m) => m.action === 'nodes', timeout, what: 'device list' });
    const meshesMsg = await meshesP;
    if (nodesMsg.result && nodesMsg.result !== 'ok') throw new MeshError(`Server refused to list devices: ${nodesMsg.result}`);
    return { meshes: meshesMsg.meshes || [], nodes: nodesMsg.nodes || {} };
  }

  /** Short-lived cookies used to authenticate relay (tunnel) WebSockets. */
  async authCookie() {
    const msg = await this.request({ action: 'authcookie' }, { match: (m) => m.action === 'authcookie', what: 'relay authentication cookie' });
    return { cookie: msg.cookie, rcookie: msg.rcookie };
  }

  /**
   * One-hour login cookie for the web UI (?login=...). Only issued when the server config has
   * settings.allowLoginToken = true; otherwise the server stays silent and this returns null.
   */
  async loginCookie({ timeout = 4000 } = {}) {
    try {
      const msg = await this.request({ action: 'logincookie' }, { match: (m) => m.action === 'logincookie', timeout, what: 'login cookie' });
      return msg.cookie || null;
    } catch (err) {
      if (err instanceof NetworkError && /Timed out/.test(err.message)) return null;
      throw err;
    }
  }

  async createLoginToken({ name, expireMinutes = 0 }) {
    const msg = await this.request({ action: 'createLoginToken', name, expire: expireMinutes }, { match: (m) => m.action === 'createLoginToken', what: 'login token' });
    if (msg.result) throw new MeshError(`Server refused to create a login token: ${msg.result}`);
    return { name: msg.name, user: msg.tokenUser, password: msg.tokenPass, created: msg.created, expire: msg.expire };
  }

  async listLoginTokens({ remove } = {}) {
    const msg = await this.request({ action: 'loginTokens', ...(remove ? { remove } : {}) }, { match: (m) => m.action === 'loginTokens', timeout: 8000, what: 'login token list' });
    return msg.loginTokens || [];
  }

  async twoFactorCookie() {
    try {
      const msg = await this.request({ action: 'twoFactorCookie' }, { match: (m) => m.action === 'twoFactorCookie', timeout: 5000 });
      return msg.cookie || null;
    } catch { return null; }
  }

  async runCommand(nodeId, command, { type = 0, runAsUser = 0, timeout = 120000 } = {}) {
    const msg = await this.request(
      { action: 'runcommands', nodeids: [nodeId], type, cmds: command, runAsUser, reply: true },
      { timeout, what: 'command output', match: undefined },
    );
    if (msg.action === 'runcommands' && msg.result !== undefined) {
      // A direct "runcommands" answer is an error (with reply:true the output arrives as a "msg").
      throw new MeshError(`Remote command failed: ${msg.result}`);
    }
    return String(msg.result ?? '');
  }

  async simple(obj, { what } = {}) {
    const msg = await this.request(obj, { what });
    if (msg.result && !/^ok$/i.test(msg.result)) throw new MeshError(`${what || obj.action}: ${msg.result}`);
    return msg;
  }
}
