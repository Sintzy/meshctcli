// Local TCP port forwarding through the MeshCentral relay (like MeshCentral Router).
// Every accepted local connection opens its own relay WebSocket to device:remotePort.
import net from 'node:net';
import { openRelay } from '../mesh/relay.js';
import { MeshError } from '../errors.js';

/**
 * @returns {Promise<{ server: net.Server, port: number, close: () => void }>}
 */
export function startTunnel(client, device, { remotePort, remoteHost, localPort = 0, bindAddress = '127.0.0.1', onEvent = () => {} }) {
  return new Promise((resolve, reject) => {
    let connections = 0;
    const server = net.createServer(async (socket) => {
      const n = ++connections;
      socket.pause();
      onEvent('open', { n, from: `${socket.remoteAddress}:${socket.remotePort}` });
      let ws;
      try {
        ({ ws } = await openRelay(client, { nodeId: device.id, tcpport: remotePort, tcpaddr: remoteHost, timeout: 30000 }));
      } catch (err) {
        onEvent('error', { n, error: err });
        socket.destroy();
        return;
      }
      ws.on('message', (data) => { if (!socket.destroyed) socket.write(Buffer.isBuffer(data) ? data : Buffer.from(data)); });
      ws.on('close', () => { socket.end(); onEvent('close', { n }); });
      ws.on('error', () => socket.destroy());
      socket.on('data', (chunk) => { if (ws.readyState === 1) ws.send(chunk); });
      socket.on('close', () => { try { ws.close(); } catch { /* ignore */ } });
      socket.on('error', () => { try { ws.close(); } catch { /* ignore */ } });
      socket.resume();
    });
    server.on('error', (err) => reject(new MeshError(err.code === 'EADDRINUSE' ? `Local port ${localPort} is already in use.` : `Cannot listen on ${bindAddress}:${localPort}: ${err.message}`)));
    server.listen(localPort, bindAddress, () => {
      const port = server.address().port;
      resolve({ server, port, close: () => server.close() });
    });
  });
}
