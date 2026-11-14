// list, info, refresh, groups
import * as t from '../ui/term.js';
import { filterDevices, OS_LABEL, can } from '../mesh/devices.js';
import { formatBytes, sanitize, formatRelativeTime } from '../ui/format.js';
import { UsageError } from '../errors.js';

const OS_VALUES = ['windows', 'linux', 'macos', 'freebsd', 'android'];

export const list = {
  name: 'list',
  aliases: ['ls', 'devices'],
  summary: 'List devices with status (filters: --os, --group, --online, --offline)',
  usage: 'mesh list [filter] [--os windows|linux|macos] [--group name] [--online|--offline] [--json]',
  positionals: [{ name: 'filter' }],
  options: { os: { type: 'string' }, group: { type: 'string' }, online: { type: 'boolean' }, offline: { type: 'boolean' } },
  async run(ctx, { args, opts }) {
    if (opts.os && !OS_VALUES.includes(opts.os)) throw new UsageError(`--os must be one of: ${OS_VALUES.join(', ')}.`);
    const all = await ctx.devices({ refresh: true });
    const devices = filterDevices(all, { os: opts.os, group: opts.group, online: opts.online ? true : opts.offline ? false : undefined, text: args.filter });
    if (opts.json) { t.print(JSON.stringify(devices, null, 2)); return; }
    t.title('MeshCentral', `${ctx.profile.user ? `${ctx.profile.user}@` : ''}${ctx.host}`);
    if (!devices.length) { t.result('warn', all.length ? 'No device matches the filters.' : 'No devices are visible to this account.'); return; }
    const online = devices.filter((d) => d.online).length;
    t.print();
    t.status(online === devices.length ? 'ok' : 'warn', `${devices.length} device${devices.length === 1 ? '' : 's'}: ${t.c.green(`${online} online`)}, ${t.c.yellow(`${devices.length - online} offline`)}`);
    const groups = new Map();
    for (const d of devices) {
      const key = d.group || 'Devices';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    const width = Math.min(36, Math.max(...devices.map((d) => d.name.length)));
    for (const [group, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      t.section(`${group} ${t.c.dim(`(${members.length})`)}`);
      for (const d of members) {
        t.item(d.online ? 'ok' : 'skip', t.c.bold(sanitize(d.name)), `${t.sym.dot} ${d.os}${d.online ? '' : ` ${t.sym.dot} offline`}${d.users.length ? ` ${t.sym.dot} ${d.users.map(sanitize).join(', ')}` : ''}`, { width, indent: 4 });
      }
    }
    t.print();
  },
};

export const refresh = {
  name: 'refresh',
  summary: 'Refresh the device cache used for Tab completion',
  usage: 'mesh refresh',
  async run(ctx) {
    const devices = await ctx.devices({ refresh: true });
    t.result('ok', `${devices.length} devices cached for completion.`);
  },
};

export const groups = {
  name: 'groups',
  summary: 'List device groups',
  usage: 'mesh groups [--json]',
  async run(ctx, { opts }) {
    const client = await ctx.client();
    const { meshes, nodes } = await client.listDevices();
    const rows = meshes.map((m) => ({ id: m._id, name: m.name, type: m.mtype === 2 ? 'agent' : m.mtype === 1 ? 'Intel AMT' : 'local', devices: (nodes[m._id] || []).length, description: m.desc || '' }));
    if (opts.json) { t.print(JSON.stringify(rows, null, 2)); return; }
    t.title('Device groups', ctx.host);
    if (!rows.length) { t.result('warn', 'No device groups visible.'); return; }
    t.print();
    t.table(rows.map((r) => ({ ...r, name: sanitize(r.name), description: sanitize(r.description) })), [
      { key: 'name', label: 'Name', color: (v) => t.c.bold(v) }, { key: 'type', label: 'Type' }, { key: 'devices', label: 'Devices' }, { key: 'description', label: 'Description' },
    ]);
  },
};

export const info = {
  name: 'info',
  summary: 'Detailed information about a device',
  usage: 'mesh info <device> [--json]',
  positionals: [{ name: 'device' }],
  async run(ctx, { args, opts }) {
    const device = await ctx.device(args.device);
    const client = await ctx.client();
    // These replies carry no responseid: match on action + nodeid.
    const ask = (action, extra = {}) => client.request({ action, nodeid: device.id, ...extra }, {
      match: (m) => m.action === action && m.nodeid === device.id, timeout: 10000,
    }).then((m) => (m.noinfo ? null : m)).catch(() => null);
    const [sys, net, last] = await Promise.all([ask('getsysinfo', { nodeinfo: true }), ask('getnetworkinfo'), ask('lastconnect')]);
    const hw = sys?.hardware || {};
    const identifiers = hw.identifiers || {};
    const winInfo = hw.windows || {};
    const ram = Array.isArray(winInfo.memory) ? winInfo.memory.reduce((a, m) => a + Number(m.Capacity || 0), 0) : null;
    const lastTime = last?.time || device.lastConnect;
    const data = {
      ...device,
      lastConnectAddress: last?.addr || null,
      lastConnectTime: lastTime || null,
      cpu: identifiers.cpu_name || null,
      boardVendor: identifiers.board_vendor || null,
      product: identifiers.product_name || null,
      biosVersion: identifiers.bios_version || null,
      memory: ram || null,
      network: net?.netif2 ? Object.entries(net.netif2).map(([n, addrs]) => ({ name: n, addresses: (addrs || []).map((a) => a.address).filter(Boolean) })) : [],
    };
    if (opts.json) { t.print(JSON.stringify(data, null, 2)); return; }
    t.title(sanitize(device.name), `${OS_LABEL[device.os]} ${t.sym.dot} ${device.online ? 'online' : 'offline'}`);
    t.section('Device');
    t.keyValues([
      ['Name', t.c.bold(sanitize(device.name))], ['Group', sanitize(device.group)], ['Node ID', t.c.dim(device.id)],
      ['OS', sanitize(device.osDesc || OS_LABEL[device.os])], ['Agent', device.agentVersion ? `v${device.agentVersion} (architecture ${device.agentId})` : device.agentId != null ? `architecture ${device.agentId}` : null],
      ['Status', device.online ? t.c.green('online') : t.c.yellow('offline')], ['Power', device.power],
      ['Users', device.users.length ? device.users.map(sanitize).join(', ') : null], ['Tags', device.tags.length ? device.tags.map(sanitize).join(', ') : null],
      ['Description', device.description ? sanitize(device.description) : null],
      ['Last seen', lastTime ? `${new Date(lastTime).toLocaleString()} (${formatRelativeTime(lastTime)})${data.lastConnectAddress ? ` from ${data.lastConnectAddress}` : ''}` : null],
      ['Features', ['desktop', 'terminal', 'files'].filter((f) => can(device, f)).join(', ') || null],
    ]);
    if (data.cpu || data.product || data.memory) {
      t.section('Hardware');
      t.keyValues([['Model', [data.boardVendor, data.product].filter(Boolean).map(sanitize).join(' ') || null], ['CPU', data.cpu && sanitize(data.cpu)], ['Memory', data.memory ? formatBytes(data.memory) : null], ['BIOS', data.biosVersion && sanitize(data.biosVersion)]].filter(([, v]) => v));
    }
    if (data.network.length) {
      t.section('Network');
      t.keyValues(data.network.filter((n) => n.addresses.length).map((n) => [sanitize(n.name), n.addresses.join(', ')]));
    }
  },
};
