// toast, message, open-url, restart, shutdown, sleep, wake
import * as t from '../ui/term.js';
import { sanitize } from '../ui/format.js';
import { confirmDangerous, isInteractive } from '../ui/prompt.js';
import { MeshError, UsageError, CancelledError, EXIT } from '../errors.js';

/** Resolve either one device (positional) or every device of --group. */
async function targets(ctx, deviceQuery, group, { onlineOnly = true } = {}) {
  if (group) {
    const devices = (await ctx.devices()).filter((d) => (d.group || '').toLowerCase() === group.toLowerCase());
    if (!devices.length) throw new MeshError(`No devices in group "${group}".`, { exitCode: EXIT.NOT_FOUND });
    return onlineOnly ? devices.filter((d) => d.online) : devices;
  }
  return [await ctx.device(deviceQuery, { requireOnline: onlineOnly })];
}

function report(results, verb) {
  for (const r of results) t.item(r.ok ? 'ok' : 'fail', t.c.bold(sanitize(r.name)), r.ok ? verb : sanitize(r.error));
  const failed = results.filter((r) => !r.ok).length;
  t.result(failed ? 'fail' : 'ok', failed ? `${failed} of ${results.length} failed.` : `${verb[0].toUpperCase()}${verb.slice(1)}: ${results.length} device${results.length === 1 ? '' : 's'}.`);
  if (failed) process.exitCode = EXIT.ERROR;
}

function messageCommand(name, summary, build, aliases = []) {
  return {
    name, aliases, summary,
    usage: `mesh ${name} <device> "<text>" [--title text]   |   mesh ${name} --group <name> "<text>"`,
    positionals: [{ name: 'rest', rest: true }],
    options: { title: { type: 'string' }, group: { type: 'string' } },
    async run(ctx, { args, opts }) {
      const rest = [...args.rest];
      const deviceQuery = opts.group ? null : rest.shift();
      const text = rest.join(' ').trim();
      if (!text) throw new UsageError(`Usage: ${this.usage}`);
      const list = await targets(ctx, deviceQuery, opts.group);
      const client = await ctx.client();
      const results = [];
      for (const d of list) {
        try { await client.simple(build(d, text, opts.title || 'MeshCentral'), { what: name }); results.push({ name: d.name, ok: true }); } catch (err) { results.push({ name: d.name, ok: false, error: err.message }); }
      }
      report(results, name === 'toast' ? 'notification sent' : 'message shown');
    },
  };
}

export const toast = messageCommand('toast', 'Show a toast notification on the device', (d, msg, title) => ({ action: 'toast', nodeids: [d.id], title, msg }), ['notify']);
export const message = messageCommand('message', 'Show a message box on the device', (d, msg, title) => ({ action: 'msg', type: 'messagebox', nodeid: d.id, title, msg, timeout: 120000 }), ['msg']);

export const openUrl = {
  name: 'open',
  summary: 'Open a URL in the browser of the remote device',
  usage: 'mesh open <device> <https://url>',
  positionals: [{ name: 'device', required: true }, { name: 'url', required: true }],
  async run(ctx, { args }) {
    if (!/^https?:\/\/\S+$/i.test(args.url)) throw new UsageError('The URL must start with http:// or https://.');
    const device = await ctx.device(args.device, { requireOnline: true });
    const client = await ctx.client();
    await client.simple({ action: 'msg', type: 'openUrl', nodeid: device.id, url: args.url }, { what: 'open URL' });
    t.result('ok', `Asked ${sanitize(device.name)} to open ${args.url}.`);
  },
};

// actiontype values from meshctrl.js / meshuser.js
const POWER = {
  restart: { action: 3, verb: 'restart requested', label: 'Restart' },
  shutdown: { action: 2, verb: 'shutdown requested', label: 'Shut down' },
  sleep: { action: 4, verb: 'sleep requested', label: 'Sleep', summary: 'Put the device to sleep (asks for confirmation)' },
};

function powerCommand(name, aliases = []) {
  const spec = POWER[name];
  return {
    name, aliases,
    summary: spec.summary || `${spec.label} the device (asks for confirmation)`,
    usage: `mesh ${name} <device> [--yes]   |   mesh ${name} --group <name> [--yes]`,
    positionals: [{ name: 'device' }],
    options: { group: { type: 'string' } },
    async run(ctx, { args, opts }) {
      const list = await targets(ctx, args.device, opts.group);
      if (!list.length) throw new MeshError('No online devices to act on.', { exitCode: EXIT.OFFLINE });
      const what = list.length === 1 ? list[0].name : `${list.length} devices in "${opts.group}"`;
      if (!opts.yes && ctx.profile.confirmDestructive !== false) {
        if (!isInteractive()) throw new UsageError(`Refusing to ${name} without confirmation.`, { hint: 'Pass --yes to confirm in scripts.' });
        if (list.length > 1) t.detail(list.map((d) => d.name).join(', '), 2);
        if (!(await confirmDangerous(spec.label, what, { expected: list.length === 1 ? list[0].name : 'yes' }))) throw new CancelledError();
      }
      const client = await ctx.client();
      const msg = await client.request({ action: 'poweraction', nodeids: list.map((d) => d.id), actiontype: spec.action }, { what: name });
      if (msg.result && !/^ok$/i.test(msg.result)) throw new MeshError(`${spec.label} failed: ${msg.result}`);
      report(list.map((d) => ({ name: d.name, ok: true })), spec.verb);
    },
  };
}

export const restart = powerCommand('restart', ['reboot']);
export const shutdown = powerCommand('shutdown', ['poweroff']);
export const sleep = powerCommand('sleep');

export const wake = {
  name: 'wake',
  summary: 'Send Wake-on-LAN through other agents on the same network',
  usage: 'mesh wake <device>   |   mesh wake --group <name>',
  positionals: [{ name: 'device' }],
  options: { group: { type: 'string' } },
  async run(ctx, { args, opts }) {
    const list = await targets(ctx, args.device, opts.group, { onlineOnly: false });
    const client = await ctx.client();
    const msg = await client.request({ action: 'wakedevices', nodeids: list.map((d) => d.id) }, { what: 'wake' });
    if (msg.result && !/^ok$/i.test(msg.result)) throw new MeshError(`Wake failed: ${msg.result}`);
    report(list.map((d) => ({ name: d.name, ok: true })), 'wake-on-LAN sent');
    t.detail('Wake-on-LAN needs another online agent in the same broadcast domain and WoL enabled in the BIOS/NIC.', 7);
  },
};
