// Interactive remote shell over a relay tunnel.
import { openRelay, PROTOCOL, CTRL_CHANNEL, isControlMessage } from '../mesh/relay.js';
import { MeshError, UsageError, EXIT } from '../errors.js';
import { can } from '../mesh/devices.js';

/** Pick the tunnel protocol for a device and the requested shell flavour. */
export function shellProtocol(device, { flavour = 'auto', asUser = false } = {}) {
  const windows = device.os === 'windows';
  let f = flavour === 'auto' || !flavour ? (windows ? 'powershell' : 'sh') : flavour;
  if (!windows && (f === 'powershell' || f === 'cmd')) throw new UsageError(`${f === 'cmd' ? 'CMD' : 'PowerShell'} is only available on Windows devices (${device.name} runs ${device.os}).`);
  if (f === 'bash') f = 'sh';
  if (f === 'powershell') return { protocol: asUser ? PROTOCOL.userPowershell : PROTOCOL.powershell, label: 'PowerShell' };
  if (f === 'cmd') return { protocol: asUser ? PROTOCOL.userTerminal : PROTOCOL.terminal, label: 'Command Prompt' };
  return { protocol: asUser ? PROTOCOL.userTerminal : PROTOCOL.terminal, label: 'Shell' };
}

export function privilegeNote(device, asUser) {
  if (asUser) return 'as the logged-in desktop user';
  if (device.os === 'windows') return 'as the agent service account (normally NT AUTHORITY\\SYSTEM)';
  return 'as the agent account (normally root)';
}

/**
 * Run an interactive session until the remote side closes it or the user types Enter ~ .
 * @returns {Promise<number>} exit code
 */
export async function runShell(client, device, { protocol, onStatus, onConnected, stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!can(device, 'terminal') && device.caps) throw new MeshError(`${device.name} does not offer a terminal (agent capabilities).`, { exitCode: EXIT.ERROR });
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  const { ws, recorded } = await openRelay(client, { nodeId: device.id, protocol, options: { ...size(), xterm: true }, onStatus });
  onConnected?.();
  if (recorded) onStatus?.('This session is being recorded by the server.', 'warn');

  return new Promise((resolve) => {
    const tty = Boolean(stdin.isTTY && typeof stdin.setRawMode === 'function');
    const wasRaw = tty ? stdin.isRaw : false;
    let lineStart = true;
    let tildePending = false;
    let closed = false;

    const sendSize = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ ctrlChannel: CTRL_CHANNEL, type: 'termsize', ...size() })); };
    sendSize(); // some agents only honour the initial size after the first termsize

    const onInput = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      // ssh-style escape: Enter, "~", "." disconnects.
      let out = buf;
      if (tty) {
        const bytes = [];
        for (const byte of buf) {
          if (tildePending) {
            tildePending = false;
            if (byte === 0x2e) { cleanup(); return; }
            bytes.push(0x7e);
          } else if (lineStart && byte === 0x7e) { tildePending = true; continue; }
          lineStart = byte === 0x0d || byte === 0x0a;
          bytes.push(byte);
        }
        out = Buffer.from(bytes);
      }
      if (out.length && ws.readyState === 1) ws.send(out);
    };

    function cleanup(code = 0) {
      if (closed) return;
      closed = true;
      stdin.off('data', onInput);
      stdin.off('end', onEnd);
      stdout.off('resize', sendSize);
      if (tty) stdin.setRawMode(wasRaw);
      stdin.pause();
      try { if (ws.readyState === 1) ws.send(JSON.stringify({ ctrlChannel: CTRL_CHANNEL, type: 'close' })); ws.close(); } catch { /* ignore */ }
      resolve(code);
    }
    const onEnd = () => setTimeout(() => cleanup(0), 500); // piped input: allow last output to arrive

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString();
        const ctrl = isControlMessage(text);
        if (ctrl) {
          if (ctrl.type === 'ping') ws.send(JSON.stringify({ ctrlChannel: CTRL_CHANNEL, type: 'pong' }));
          else if (ctrl.type === 'console' && ctrl.msg) onStatus?.(String(ctrl.msg));
          return;
        }
      }
      stdout.write(data);
    });
    ws.on('close', () => cleanup(0));
    ws.on('error', () => cleanup(EXIT.NETWORK));

    if (tty) stdin.setRawMode(true);
    stdin.on('data', onInput);
    stdin.on('end', onEnd);
    stdin.resume();
    stdout.on('resize', sendSize);
  });
}
