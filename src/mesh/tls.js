// TLS policy: verification is always on unless the profile explicitly opts out.
// Self-signed MeshCentral servers are supported by trusting (pinning) their root certificate.
import fs from 'node:fs';
import tls from 'node:tls';
import { MeshError, NetworkError } from '../errors.js';

/**
 * ws/https options for a profile.
 *  - default: normal CA + hostname verification (Node's trust store, plus tls.ca if configured)
 *  - tls.fingerprint: certificate pinning (trust-on-first-use for self-signed MeshCentral servers).
 *    The TLS handshake completes and the SHA-256 fingerprint is checked *before* any HTTP data
 *    (and therefore before the x-meshauth credentials) is written to the socket.
 *  - tls.insecure: no verification at all (explicit opt-in only).
 */
export function tlsOptions(profile) {
  const t = profile.tls || {};
  const opts = { rejectUnauthorized: !t.insecure };
  if (t.ca) {
    try { opts.ca = fs.readFileSync(t.ca, 'utf8'); } catch (err) {
      throw new MeshError(`Cannot read trusted CA file ${t.ca}: ${err.message}`, { hint: 'Fix the path with "mesh configure".' });
    }
  }
  if (t.fingerprint && !t.insecure) {
    const expected = normalizeFingerprint(t.fingerprint);
    opts.rejectUnauthorized = false; // chain is not CA-signed; the pin below replaces CA validation
    opts.createConnection = (options, callback) => {
      const socket = tls.connect({ ...options, rejectUnauthorized: false, servername: options.servername || options.host });
      socket.once('secureConnect', () => {
        const actual = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256 || '');
        if (actual !== expected) {
          socket.destroy();
          const err = new NetworkError('Server certificate does not match the pinned fingerprint.', {
            details: [`expected ${expected}`, `received ${actual || 'none'}`],
            hint: 'If the server certificate was renewed on purpose, run "mesh configure" to trust the new one.',
          });
          err.code = 'CERT_PIN_MISMATCH';
          callback(err);
          return;
        }
        callback(null, socket);
      });
      socket.once('error', (err) => callback(err));
      return undefined; // async: http.ClientRequest waits for the callback
    };
  }
  return opts;
}

export function normalizeFingerprint(fp) { return String(fp).toUpperCase().replace(/[^0-9A-F]/g, '').replace(/(..)(?!$)/g, '$1:'); }

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED', 'CERT_REVOKED',
]);
export const isTlsError = (err) => Boolean(err && (TLS_ERROR_CODES.has(err.code) || /certificate|self[- ]signed/i.test(err.message || '')));

/** Turn low level socket errors into user-facing NetworkErrors. */
export function describeNetworkError(err, host) {
  if (err instanceof MeshError) return err;
  const code = err?.code;
  if (code === 'CERT_PIN_MISMATCH') return err;
  if (isTlsError(err)) {
    return new NetworkError(`TLS certificate of ${host} is not trusted (${code || err.message}).`, {
      hint: 'If this is a self-signed MeshCentral certificate, run "mesh configure" to inspect and trust it.', cause: err,
    });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new NetworkError(`Cannot resolve host ${host}.`, { hint: 'Check the server URL and your DNS/network connection.', cause: err });
  if (code === 'ECONNREFUSED') return new NetworkError(`Connection refused by ${host}.`, { hint: 'Is MeshCentral running and is the port correct?', cause: err });
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return new NetworkError(`Connection to ${host} timed out.`, { cause: err });
  if (code === 'ECONNRESET' || code === 'EPIPE') return new NetworkError(`Connection to ${host} was reset.`, { cause: err });
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return new NetworkError(`Host ${host} is unreachable.`, { cause: err });
  return new NetworkError(`Network error talking to ${host}: ${err?.message || err}`, { cause: err });
}

function toPem(raw) {
  const b64 = raw.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/**
 * Connect without sending any data and report the presented certificate chain.
 * Used by "mesh configure" / "mesh doctor" so the user can decide whether to trust it.
 */
export function probeCertificate(base, { timeout = 10000, ca } = {}) {
  const url = new URL(base);
  if (url.protocol !== 'https:') return Promise.resolve({ secure: false, authorized: false, chain: [] });
  const port = Number(url.port || 443);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: url.hostname, port, servername: url.hostname, rejectUnauthorized: false, ca, timeout }, () => {
      const chain = [];
      const seen = new Set();
      let cert = socket.getPeerCertificate(true);
      while (cert && cert.raw && !seen.has(cert.fingerprint256)) {
        seen.add(cert.fingerprint256);
        chain.push({
          subject: cert.subject?.CN || JSON.stringify(cert.subject), issuer: cert.issuer?.CN || JSON.stringify(cert.issuer),
          validTo: cert.valid_to, fingerprint256: cert.fingerprint256, pem: toPem(cert.raw), selfSigned: cert.issuerCertificate === cert,
        });
        cert = cert.issuerCertificate;
      }
      let hostError = null;
      if (chain.length) {
        const leaf = socket.getPeerCertificate();
        hostError = tls.checkServerIdentity(url.hostname, leaf) || null;
      }
      const resultValue = { secure: true, authorized: socket.authorized, authorizationError: socket.authorizationError ? String(socket.authorizationError) : null, hostError: hostError?.message || null, chain };
      socket.end();
      resolve(resultValue);
    });
    socket.on('timeout', () => { socket.destroy(); reject(describeNetworkError({ code: 'ETIMEDOUT' }, url.host)); });
    socket.on('error', (err) => reject(describeNetworkError(err, url.host)));
  });
}

/** Leaf certificate fingerprint to pin for a probed chain. */
export function leafFingerprint(chain) { return chain[0] ? normalizeFingerprint(chain[0].fingerprint256) : null; }
