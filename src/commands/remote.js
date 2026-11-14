// shell, ps, cmd, run, web/desktop, rdp, tunnel, relay
import { spawn, spawnSync } from 'node:child_process';
import * as t from '../ui/term.js';
import { shellProtocol, privilegeNote, runShell } from '../session/shell.js';
import { startTunnel } from '../session/tunnel.js';
import { openInBrowser } from '../browser/browser.js';
import { deviceWebUrl, VIEW, HIDE } from '../mesh/url.js';
import { OS_LABEL, can } from '../mesh/devices.js';
import { sanitize } from '../ui/format.js';
import { spinner } from '../ui/progress.js';
import { MeshError, UsageError, EXIT } from '../errors.js';

const SHELL_OPTIONS = { user: { type: 'boolean' }, powershell: { type: 'boolean' }, cmd: { type: 'boolean' } };

function makeShellCommand(name, flavour, summary, aliases = []) {
  return {
    name, aliases, summary,
    usage: `mesh ${name} <device>${flavour ? '' : ' [--powershell|--cmd]'} [--user]`,
    positionals: [{ name: 'device' }],
    options: SHELL_OPTIONS,
    async run(ctx, { args, opts }) {
      const device = await ctx.device(args.device, { requireOnline: true });
      let wanted = flavour || (opts.powershell ? 'powershell' : opts.cmd ? 'cmd' : null);
      if (!wanted) wanted = device.os === 'windows' && ['powershell', 'cmd'].includes(ctx.profile.shell) ? ctx.profile.shell : 'auto';
      const { protocol, label } = shellProtocol(device, { flavour: wanted, asUser: opts.user });
      const client = await ctx.client();
      const s = process.stderr.isTTY ? spinner(`Opening ${label} on ${sanitize(device.name)}…`) : null;
      const code = await runShell(client, device, {
        protocol,
        onStatus: (msg, kind) => {
          if (s && !kind) { s.update(sanitize(msg)); return; }
          process.stderr.write(`\r\x1b[2K${t.badge(kind || 'info')} ${sanitize(msg)}\n`);
        },
        onConnected: () => {
          s?.stop();
          process.stderr.write(`${t.badge('ok')} ${t.c.bold(sanitize(device.name))} ${t.sym.dot} ${label} ${t.sym.dot} ${t.c.dim(privilegeNote(device, opts.user))}\n`);
          process.stderr.write(`${t.badge('info')} ${t.c.dim('Type "exit" to end the session, or press Enter ~ . to disconnect.')}\n`);
        },
      }).finally(() => s?.stop());
      process.stderr.write(`\n${t.badge('info')} ${t.c.dim(`Session closed (${sanitize(device.name)}).`)}\n`);
      process.exitCode = code;
    },
  };
}

export const shell = makeShellCommand('shell', null, 'Interactive shell (PowerShell on Windows, default shell elsewhere)', ['ssh', 'sh']);
export const ps = makeShellCommand('ps', 'powershell', 'Interactive PowerShell session (Windows)', ['powershell']);
export const cmd = makeShellCommand('cmd', 'cmd', 'Interactive Command Prompt session (Windows)');

// ------------------------------------------------------------------ run (one-shot command, multi-device capable)
export const run = {
  name: 'run',
  aliases: ['exec'],
  summary: 'Run a command and print its output (use --group for several devices)',
  usage: 'mesh run <device> "<command>" [--powershell|--cmd] [--user]   |   mesh run --group <name> "<command>"',
  positionals: [{ name: 'rest', rest: true }],
  options: { ...SHELL_OPTIONS, group: { type: 'string' }, 'timeout-cmd': { type: 'string' } },
  async run(ctx, { args, opts }) {
    const rest = args.rest;
    let targets;
    let command;
    if (opts.group) {
      command = rest.join(' ');
      const devices = (await ctx.devices()).filter((d) => (d.group || '').toLowerCase() === opts.group.toLowerCase());
      if (!devices.length) throw new MeshError(`No devices in group "${opts.group}".`, { exitCode: EXIT.NOT_FOUND });
      targets = devices;
    } else {
      if (rest.length < 2) throw new UsageError('Usage: mesh run <device> "<command>"', { hint: 'Quote the command, e.g. mesh run Lenovo3 "Get-Service | Select -First 5"' });
      targets = [await ctx.device(rest[0])];
      command = rest.slice(1).join(' ');
    }
    if (!command.trim()) throw new UsageError('Empty command.');
    const client = await ctx.client();
    const timeout = opts['timeout-cmd'] ? Number(opts['timeout-cmd']) * 1000 : 120000;
    const results = [];
    for (const device of targets) {
      if (!device.online) { results.push({ device: device.name, ok: false, error: 'offline' }); continue; }
      const type = device.os === 'windows' ? (opts.cmd ? 1 : 2) : 3;
      if (device.os !== 'windows' && (opts.powershell || opts.cmd)) { results.push({ device: device.name, ok: false, error: 'PowerShell/CMD only exist on Windows' }); continue; }
      const s = !opts.json && process.stderr.isTTY ? spinner(`Running on ${sanitize(device.name)}…`) : null;
      try {
        const output = await client.runCommand(device.id, command, { type, runAsUser: opts.user ? 2 : 0, timeout });
        s?.stop();
        results.push({ device: device.name, ok: true, output });
      } catch (err) {
        s?.stop();
        results.push({ device: device.name, ok: false, error: err.message });
      }
    }
    if (opts.json) { t.print(JSON.stringify(results, null, 2)); }
    else if (targets.length === 1 && results[0].ok) {
      process.stdout.write(results[0].output.endsWith('\n') || !results[0].output ? results[0].output : `${results[0].output}\n`);
    } else {
      for (const r of results) {
        t.section(sanitize(r.device));
        if (r.ok) process.stdout.write(`${r.output.replace(/\s+$/, '')}\n`); else t.status('fail', sanitize(r.error));
      }
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      if (!opts.json && targets.length === 1) throw new MeshError(failed[0].error === 'offline' ? `${targets[0].name} is offline.` : failed[0].error, { exitCode: failed[0].error === 'offline' ? EXIT.OFFLINE : EXIT.ERROR });
      process.exitCode = EXIT.ERROR;
    }
  },
};

// ------------------------------------------------------------------ web / desktop
const PANELS = { desktop: VIEW.desktop, terminal: VIEW.terminal, files: VIEW.files, general: VIEW.general, events: VIEW.events, console: VIEW.console };

export const web = {
  name: 'web',
  aliases: ['desktop'],
  summary: 'Open the device in a standalone browser window (Desktop panel by default)',
  usage: 'mesh web <device> [--panel desktop|terminal|files|general|events] [--tab] [--print-url]',
  positionals: [{ name: 'device' }],
  options: { panel: { type: 'string' }, tab: { type: 'boolean' }, 'print-url': { type: 'boolean' }, 'show-ui': { type: 'boolean' } },
  async run(ctx, { args, opts, commandWord }) {
    const panelName = opts.panel || 'desktop';
    const view = PANELS[panelName];
    if (!view) throw new UsageError(`Unknown panel "${panelName}". Use: ${Object.keys(PANELS).join(', ')}.`);
    const device = await ctx.device(args.device);
    if (panelName === 'desktop' && device.caps && !can(device, 'desktop')) t.status('warn', `${sanitize(device.name)} does not report remote desktop capability.`);
    if (!device.online) t.status('warn', `${sanitize(device.name)} is offline; the page will open but the desktop cannot connect until the agent is back.`);
    const client = await ctx.client();
    const login = await client.loginCookie();
    // Hide the header, tab bar, footer and left menu so the window feels like a dedicated viewer.
    const hide = opts['show-ui'] ? 0 : HIDE.header | HIDE.tabs | HIDE.footer | HIDE.leftbar;
    const url = deviceWebUrl(client.server, { nodeId: device.id, view, hide, login });
    if (opts['print-url']) {
      if (login) process.stderr.write(`${t.badge('warn')} The URL below contains a one-hour login cookie. Treat it like a password.\n`);
      t.print(url);
      return;
    }
    const result = await openInBrowser(url, { browser: ctx.profile.browser, browserPath: ctx.profile.browserPath, appMode: !opts.tab, sensitive: Boolean(login) });
    if (result.redirect) {
      // Give the browser time to read the one-shot redirect page, then delete it.
      const s = spinner('Opening the browser…');
      await new Promise((r) => setTimeout(r, 5000));
      result.redirect.cleanup();
      s.stop();
    }
    if (result.missing) t.status('warn', `${result.missing} was not found; opened the default browser instead (no app window).`);
    t.status('ok', `${commandWord === 'desktop' || panelName === 'desktop' ? 'Remote desktop' : `"${panelName}" panel`} for ${t.c.bold(sanitize(device.name))} opened${result.mode === 'app' ? ` in a ${result.browser} app window` : ''}.`);
    if (!login) t.detail('Sign in once in that window; the session is kept in a dedicated browser profile. For automatic sign-in enable "allowLoginToken": true in the server settings.', 7);
    if (panelName === 'desktop') t.detail('Click "Connect" in the window to start the desktop session (MeshCentral has no auto-connect URL parameter).', 7);
  },
};

// ------------------------------------------------------------------ tunnel (TCP port forwarding)
export const tunnel = {
  name: 'tunnel',
  aliases: ['forward'],
  summary: 'Forward a local TCP port to a port on (or reachable from) the device',
  usage: 'mesh tunnel <device> <remotePort> [--local-port N] [--remote-host 127.0.0.1] [--bind 127.0.0.1]',
  positionals: [{ name: 'device', required: true }, { name: 'port', required: true }],
  options: { 'local-port': { type: 'string' }, 'remote-host': { type: 'string' }, bind: { type: 'string' } },
  async run(ctx, { args, opts }) {
    const remotePort = parsePort(args.port, 'remote port');
    const localPort = opts['local-port'] ? parsePort(opts['local-port'], 'local port') : 0;
    const device = await ctx.device(args.device, { requireOnline: true });
    const client = await ctx.client();
    const bind = opts.bind || '127.0.0.1';
    if (bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1') t.status('warn', `Listening on ${bind}: other machines on your network can use this tunnel.`);
    const tun = await startTunnel(client, device, {
      remotePort, remoteHost: opts['remote-host'], localPort, bindAddress: bind,
      onEvent: (type, e) => {
        if (type === 'open') t.status('info', `Connection #${e.n} from ${e.from}`);
        if (type === 'error') t.status('fail', `Connection #${e.n}: ${sanitize(e.error.message)}`);
      },
    });
    t.status('ok', `Forwarding ${t.c.bold(`${bind}:${tun.port}`)} ${t.sym.arrow} ${sanitize(device.name)}:${opts['remote-host'] ? `${opts['remote-host']}:` : ''}${remotePort}. Press Ctrl+C to stop.`);
    await waitForInterrupt();
    tun.close();
  },
};

// ------------------------------------------------------------------ rdp (native client through a tunnel)
export const rdp = {
  name: 'rdp',
  summary: 'Native RDP client through a MeshCentral tunnel (Windows devices with RDP enabled)',
  usage: 'mesh rdp <device> [--port 3389] [--local-port N] [--no-launch]',
  positionals: [{ name: 'device' }],
  options: { port: { type: 'string' }, 'local-port': { type: 'string' }, 'no-launch': { type: 'boolean' } },
  async run(ctx, { args, opts }) {
    const device = await ctx.device(args.device, { requireOnline: true });
    if (device.os !== 'windows') throw new MeshError(`${device.name} runs ${OS_LABEL[device.os]}; native RDP is for Windows devices. Use "mesh web ${device.name}" for the MeshCentral desktop.`);
    const remotePort = opts.port ? parsePort(opts.port, 'RDP port') : device.rdpPort || 3389;
    const localPort = opts['local-port'] ? parsePort(opts['local-port'], 'local port') : 0;
    const client = await ctx.client();
    const tun = await startTunnel(client, device, { remotePort, localPort, onEvent: (type, e) => { if (type === 'error') t.status('fail', `RDP connection failed: ${sanitize(e.error.message)} (is Remote Desktop enabled on the device?)`); } });
    const target = `127.0.0.1:${tun.port}`;
    t.status('ok', `RDP tunnel ready: ${t.c.bold(target)} ${t.sym.arrow} ${sanitize(device.name)}:${remotePort}`);
    if (!opts['no-launch']) {
      const launched = launchRdpClient(target);
      if (launched) t.status('info', `Started ${launched}. Keep this terminal open; press Ctrl+C to close the tunnel.`);
      else t.status('warn', `No RDP client found. Connect your client to ${target} manually.`);
    }
    await waitForInterrupt();
    tun.close();
  },
};

function launchRdpClient(target) {
  const tryRun = (cmd, cmdArgs) => {
    try { const ch = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }); ch.on('error', () => {}); ch.unref(); return true; } catch { return false; }
  };
  if (process.platform === 'win32') return tryRun('mstsc.exe', [`/v:${target}`]) ? 'mstsc' : null;
  if (process.platform === 'darwin') {
    // Microsoft "Windows App" / Remote Desktop registers the rdp: URL scheme.
    return tryRun('open', [`rdp://full%20address=s:${target}`]) ? 'the RDP client (rdp:// handler)' : null;
  }
  for (const [bin, a] of [['xfreerdp3', [`/v:${target}`, '/dynamic-resolution']], ['xfreerdp', [`/v:${target}`, '/dynamic-resolution']], ['remmina', ['-c', `rdp://${target}`]]]) {
    if (spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', bin]).status === 0) return tryRun(bin, a) ? bin : null;
  }
  return null;
}

// ------------------------------------------------------------------ relay (MeshCentral web relay link)
export const relay = {
  name: 'relay',
  summary: 'Create a MeshCentral web relay link to an HTTP/HTTPS port on the device',
  usage: 'mesh relay <device> [http|https] [port] [--open]',
  positionals: [{ name: 'device', required: true }, { name: 'protocol' }, { name: 'port' }],
  options: { open: { type: 'boolean' } },
  async run(ctx, { args, opts }) {
    const protocol = (args.protocol || 'http').toLowerCase();
    if (!['http', 'https'].includes(protocol)) throw new UsageError('Protocol must be http or https.');
    const port = args.port ? parsePort(args.port, 'port') : protocol === 'https' ? 443 : 80;
    const device = await ctx.device(args.device, { requireOnline: true });
    const client = await ctx.client();
    const msg = await client.request({ action: 'webrelay', nodeid: device.id, port, appid: protocol === 'https' ? 2 : 1 }, { match: (m) => m.action === 'webrelay', what: 'web relay link' });
    if (msg.result !== 'OK' || !msg.url) throw new MeshError(`Web relay refused: ${msg.result || 'no URL returned'}`, { hint: 'Web relay must be enabled on the server (settings.relayDNS / webRelayPort).' });
    t.status('ok', `Web relay for ${sanitize(device.name)}:${port} (${protocol}):`);
    t.print(msg.url);
    if (opts.open) await openInBrowser(msg.url, { browser: ctx.profile.browser, browserPath: ctx.profile.browserPath, appMode: false });
  },
};

export function parsePort(value, what = 'port') {
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || n < 1 || n > 65535) throw new UsageError(`Invalid ${what} "${value}" (1-65535).`);
  return n;
}

function waitForInterrupt() {
  return new Promise((resolve) => {
    const done = () => { process.off('SIGINT', done); process.off('SIGTERM', done); process.stderr.write('\n'); resolve(); };
    process.on('SIGINT', done);
    process.on('SIGTERM', done);
  });
}
