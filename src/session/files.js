// File operations over the "files" relay protocol (p=5): ls, mkdir, rm, upload, download.
//
// Protocol notes (agents/meshcore.js):
//  * every agent answer is a JSON object, sent as a binary frame starting with "{"
//  * download blocks: 4-byte header (0x01000000, last block 0x01000001) + up to 16380 bytes; each
//    block except the last must be acknowledged with {action:'download', sub:'ack'}
//  * upload chunks: raw binary; a chunk that starts with 0x00 or "{" must be prefixed with 0x00.
//    The agent acks every chunk with {action:'uploadack'}; {action:'uploaddone'} closes the file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openRelay, PROTOCOL, isControlMessage, CTRL_CHANNEL } from '../mesh/relay.js';
import { MeshError, NetworkError, EXIT } from '../errors.js';

export const UPLOAD_CHUNK = 65535;
export const UPLOAD_WINDOW = 16;

/** Path helpers for the remote OS. */
export function remotePath(os) {
  const p = os === 'windows' ? path.win32 : path.posix;
  return {
    join: (...parts) => p.join(...parts),
    dirname: (x) => p.dirname(x),
    basename: (x) => p.basename(x),
    normalize: (x) => (os === 'windows' ? String(x).replace(/\//g, '\\') : String(x)),
    isAbsolute: (x) => p.isAbsolute(x) || (os === 'windows' && /^[A-Za-z]:$/.test(x)),
  };
}

/** Encode one upload chunk according to the escaping rule. */
export function encodeUploadChunk(buf) {
  if (buf.length && (buf[0] === 0 || buf[0] === 123)) return Buffer.concat([Buffer.from([0]), buf]);
  return buf;
}

export class FileSession {
  constructor(ws, device) {
    this.ws = ws;
    this.device = device;
    this.rp = remotePath(device.os);
    this.handlers = new Set();
    this.closed = false;
    ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary));
    ws.on('close', () => { this.closed = true; for (const h of [...this.handlers]) h.onClose?.(); });
    ws.on('error', () => { /* surfaced through close */ });
  }

  static async open(client, device, { onStatus } = {}) {
    const { ws } = await openRelay(client, { nodeId: device.id, protocol: PROTOCOL.files, onStatus });
    return new FileSession(ws, device);
  }

  #onMessage(data, isBinary) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length && buf[0] === 123) {
      const text = buf.toString('utf8');
      const ctrl = isControlMessage(text);
      if (ctrl) { if (ctrl.type === 'ping') this.ws.send(JSON.stringify({ ctrlChannel: CTRL_CHANNEL, type: 'pong' })); return; }
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      for (const h of [...this.handlers]) h.onJson?.(msg);
    } else if (isBinary || buf.length) {
      for (const h of [...this.handlers]) h.onBinary?.(buf);
    }
  }

  #session(handler, { timeout = 30000, what }) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new NetworkError('File session is closed.'));
      let timer = null;
      const arm = () => { clearTimeout(timer); if (timeout) timer = setTimeout(() => done(new NetworkError(`Timed out waiting for ${what}.`)), timeout); };
      const done = (err, value) => { clearTimeout(timer); this.handlers.delete(h); err ? reject(err) : resolve(value); };
      const h = {
        onJson: (m) => { arm(); handler.onJson?.(m, done); },
        onBinary: (b) => { arm(); handler.onBinary?.(b, done); },
        onClose: () => done(new NetworkError(`Connection closed during ${what}.`)),
      };
      this.handlers.add(h);
      arm();
      handler.start?.(done);
    });
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  /** List a directory. Empty path on Windows lists drives. Returns null if the path does not exist. */
  ls(dirPath) {
    const reqid = crypto.randomBytes(6).toString('hex');
    return this.#session({
      start: () => this.send({ action: 'ls', reqid, path: dirPath }),
      onJson: (m, done) => { if (m.reqid === reqid || (m.path === dirPath && 'dir' in m)) done(null, m.dir === null || m.dir === undefined ? null : m.dir.map(entryFromAgent)); },
    }, { what: `directory listing of ${dirPath || '/'}` });
  }

  /** Stat a remote path by listing its parent. */
  async stat(remote) {
    const parent = this.rp.dirname(remote);
    const name = this.rp.basename(remote);
    if (!name || parent === remote) return { name: remote, type: 'dir' };
    const entries = await this.ls(parent);
    if (!entries) return null;
    const cmp = this.device.os === 'windows' ? (a) => a.toLowerCase() === name.toLowerCase() : (a) => a === name;
    return entries.find((e) => cmp(e.name)) || null;
  }

  mkdir(dirPath) {
    this.send({ action: 'mkdir', reqid: 'mkdir', path: dirPath });
  }

  rm(dirPath, names, { recursive = false } = {}) {
    this.send({ action: 'rm', reqid: 'rm', path: dirPath, delfiles: names, rec: recursive });
  }

  /**
   * Upload a local file into a remote directory.
   * @returns {Promise<number>} bytes acknowledged by the agent
   */
  upload(localFile, remoteDir, remoteName, { onProgress = () => {}, signal } = {}) {
    const size = fs.statSync(localFile).size;
    const fd = fs.openSync(localFile, 'r');
    const reqid = crypto.randomBytes(6).toString('hex');
    let offset = 0;
    let inFlight = 0;
    let acked = 0;
    let eof = false;
    const pendingSizes = [];
    const buffer = Buffer.alloc(UPLOAD_CHUNK);
    const sendNext = () => {
      if (eof) return false;
      const len = fs.readSync(fd, buffer, 0, UPLOAD_CHUNK, offset);
      if (len <= 0) { eof = true; return false; }
      offset += len;
      inFlight++;
      pendingSizes.push(len);
      this.ws.send(encodeUploadChunk(Buffer.from(buffer.subarray(0, len))));
      return true;
    };
    const close = () => { try { fs.closeSync(fd); } catch { /* already closed */ } };
    return this.#session({
      start: (done) => {
        signal?.addEventListener('abort', () => { close(); done(new MeshError('Upload cancelled.', { exitCode: EXIT.CANCELLED })); });
        this.send({ action: 'upload', reqid, path: remoteDir, name: remoteName, size });
      },
      onJson: (m, done) => {
        if (m.reqid !== undefined && m.reqid !== reqid) return;
        if (m.action === 'uploaderror') { close(); return done(new MeshError(`The device could not write ${this.rp.join(remoteDir, remoteName)} (permission denied or invalid path).`)); }
        if (m.action === 'uploadstart') {
          for (let i = 0; i < UPLOAD_WINDOW && sendNext(); i++) { /* fill window */ }
        } else if (m.action === 'uploadack') {
          inFlight--;
          acked += pendingSizes.shift() || 0;
          onProgress(acked, size);
          sendNext();
        } else if (m.action === 'uploaddone') {
          close();
          return done(null, acked);
        } else return;
        if (eof && inFlight === 0) this.send({ action: 'uploaddone', reqid });
      },
    }, { what: 'upload acknowledgement', timeout: 60000 });
  }

  /**
   * Download a remote file to a local path. Writes to "<dest>.part" and renames on success.
   * @returns {Promise<number>} bytes written
   */
  download(remoteFile, localFile, { overwrite = false, onProgress = () => {} } = {}) {
    const id = remoteFile;
    const partial = `${localFile}.part`;
    let fd = null;
    let written = 0;
    const cleanup = (keep) => {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } fd = null; }
      if (!keep) { try { fs.unlinkSync(partial); } catch { /* ignore */ } }
    };
    return this.#session({
      start: () => this.send({ action: 'download', sub: 'start', id, path: remoteFile }),
      onJson: (m, done) => {
        if (m.action !== 'download' || m.id !== id) return;
        if (m.sub === 'start') {
          try { fd = fs.openSync(partial, 'w'); } catch (err) { return done(new MeshError(`Cannot create ${partial}: ${err.message}`)); }
          this.send({ action: 'download', sub: 'startack', id });
        } else if (m.sub === 'cancel') {
          cleanup(false);
          done(new MeshError(`The device refused to read ${remoteFile} (missing file or permission denied).`));
        }
      },
      onBinary: (buf, done) => {
        if (fd === null || buf.length < 4) return;
        const flags = buf.readUInt32BE(0);
        try { fs.writeSync(fd, buf, 4, buf.length - 4); } catch (err) { cleanup(false); return done(new MeshError(`Write failed: ${err.message}`)); }
        written += buf.length - 4;
        onProgress(written);
        if (flags & 1) {
          cleanup(true);
          try {
            if (!overwrite && fs.existsSync(localFile)) throw new MeshError(`${localFile} appeared during the download; kept as ${partial}.`);
            fs.renameSync(partial, localFile);
          } catch (err) { return done(err instanceof MeshError ? err : new MeshError(`Cannot finalise ${localFile}: ${err.message}`)); }
          done(null, written);
        } else {
          this.send({ action: 'download', sub: 'ack', id });
        }
      },
    }, { what: 'download data', timeout: 60000 }).catch((err) => { cleanup(false); throw err; });
  }

  close() {
    try { this.ws.send(JSON.stringify({ ctrlChannel: CTRL_CHANNEL, type: 'close' })); this.ws.close(); } catch { /* ignore */ }
  }
}

export function entryFromAgent(e) {
  const type = e.t === 1 ? 'drive' : e.t === 2 ? 'dir' : 'file';
  return { name: e.n, type, size: typeof e.s === 'number' ? e.s : null, mtime: e.d ? new Date(e.d) : null, free: e.f ?? null };
}
