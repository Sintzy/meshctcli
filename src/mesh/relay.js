// Relay tunnels (meshrelay.ashx) between this CLI and a device agent.
//
// Flow (same as the MeshCentral web UI / meshctrl.js):
//   1. control channel: {action:'authcookie'} -> { cookie, rcookie }
//   2. control channel: {action:'msg', type:'tunnel', nodeid, value:'*/meshrelay.ashx?p=..&id=..&rauth=rcookie'}
//      asks the agent to dial into the relay with the same id
//   3. we open wss://server/meshrelay.ashx?browser=1&p=..&nodeid=..&id=..&auth=cookie
//   4. server sends "c" (or "cr" = session recorded) once both ends are paired
//   5. we send the protocol number, then data flows.
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { relayUrl, agentRelayPath, hostLabel } from './url.js';
import { tlsOptions, describeNetworkError } from './tls.js';
import { MeshError, NetworkError, EXIT } from '../errors.js';

export const PROTOCOL = Object.freeze({
  terminal: 1,        // cmd.exe / root shell, as the agent service account
  desktop: 2,
  files: 5,
  powershell: 6,      // PowerShell as the agent service account (Windows)
  userTerminal: 8,    // shell as the logged-in user
  userPowershell: 9,  // PowerShell as the logged-in user (Windows)
});

export const CTRL_CHANNEL = '102938';

export function isControlMessage(text) {
  if (typeof text !== 'string' || text[0] !== '{' || !text.includes('"ctrlChannel"')) return null;
  try {
    const msg = JSON.parse(text);
    return msg && String(msg.ctrlChannel) === CTRL_CHANNEL ? msg : null;
  } catch { return null; }
}

/**
 * Open a relay tunnel to a device and resolve once the agent is connected.
 * @returns {Promise<{ ws: WebSocket, recorded: boolean }>}
 */
export async function openRelay(client, { nodeId, protocol, options, tcpport, tcpaddr, timeout = 60000, onStatus = () => {}, WebSocketImpl = WebSocket }) {
  const { cookie, rcookie } = await client.authCookie();
  const server = client.server;
  const id = crypto.randomBytes(12).toString('hex');
  let url;
  if (tcpport) {
    // TCP port forwarding: the server itself asks the agent to connect to tcpaddr:tcpport.
    url = relayUrl(server, { nodeid: nodeId, tcpport, tcpaddr, id, auth: cookie });
  } else {
    url = relayUrl(server, { browser: 1, p: protocol, nodeid: nodeId, id, auth: cookie });
    client.send({ action: 'msg', type: 'tunnel', nodeid: nodeId, usage: protocol, value: agentRelayPath(server, { p: protocol, nodeid: nodeId, id, rauth: rcookie }) });
  }
  const host = hostLabel(server.base);
  onStatus('Waiting for the agent…');
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url, { ...tlsOptions(client.profile), perMessageDeflate: false, handshakeTimeout: 20000 });
    let settled = false;
    const timer = setTimeout(() => fail(new NetworkError('Timed out waiting for the device agent to join the session.', {
      exitCode: EXIT.OFFLINE, hint: 'The agent may be offline, or a user consent prompt on the device was not answered.',
    })), timeout);
    function fail(err) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { ws.terminate(); } catch { /* ignore */ }
      reject(err);
    }
    ws.on('message', function onMessage(data, isBinary) {
      if (settled) return;
      const text = isBinary ? null : data.toString();
      if (text === 'c' || text === 'cr') {
        settled = true; clearTimeout(timer);
        ws.off('message', onMessage);
        if (!tcpport) {
          if (options) ws.send(JSON.stringify({ ctrlChannel: CTRL_CHANNEL, type: 'options', ...options }));
          ws.send(String(protocol));
        }
        resolve({ ws, recorded: text === 'cr' });
        return;
      }
      const ctrl = isControlMessage(text);
      if (ctrl?.type === 'console' && ctrl.msg) onStatus(String(ctrl.msg));
    });
    ws.on('unexpected-response', (_req, res) => fail(new MeshError(`Relay refused the connection (HTTP ${res.statusCode}).`, { exitCode: EXIT.AUTH })));
    ws.on('error', (err) => fail(describeNetworkError(err, host)));
    ws.on('close', (code) => fail(new MeshError(`Relay closed before the agent connected${code ? ` (code ${code})` : ''}.`, {
      exitCode: EXIT.OFFLINE, hint: 'Check that the device is online and that your account has rights for this feature.',
    })));
  });
}
