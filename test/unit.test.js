// Pure unit tests (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, visibleWidth, formatBytes, formatDuration, truncate, sanitize, padEnd } from '../src/ui/format.js';
import { normalizeServerUrl, controlUrl, relayUrl, deviceWebUrl, agentRelayPath, shortNodeId, VIEW, HIDE } from '../src/mesh/url.js';
import { detectOs, normalizeDevices, matchDevices, filterDevices } from '../src/mesh/devices.js';
import { splitCommand, parseCommandArgs } from '../src/cli/args.js';
import { complete } from '../src/completion/complete.js';
import { patchRcText, unpatchRcText, sourceLine, MARKER } from '../src/completion/install.js';
import { badge, configureTerminal, detectColor, BADGE_WIDTH } from '../src/ui/term.js';
import { filterItems, renderPicker } from '../src/ui/picker.js';
import { TransferProgress } from '../src/ui/progress.js';
import { encodeUploadChunk, remotePath, entryFromAgent } from '../src/session/files.js';
import { safeLocalName, splitWords } from '../src/commands/files.js';
import { meshAuthHeader, closeMessageToError } from '../src/mesh/client.js';
import { shellProtocol } from '../src/session/shell.js';
import { normalizeFingerprint } from '../src/mesh/tls.js';
import { closestCommand } from '../src/cli/main.js';
import { MOCK_NODES } from './helpers.js';

test('format helpers', () => {
  assert.equal(stripAnsi('\x1b[42;30m OK \x1b[0m'), ' OK ');
  assert.equal(visibleWidth('\x1b[1mabc\x1b[0m'), 3);
  assert.equal(visibleWidth('日本'), 4);
  assert.equal(padEnd('\x1b[1mab\x1b[0m', 4), '\x1b[1mab\x1b[0m  ');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(300 * 1024 * 1024), '300 MB');
  assert.equal(formatBytes(-1), '?');
  assert.equal(formatDuration(3.25), '3.3s');
  assert.equal(formatDuration(75), '1m 15s');
  assert.equal(formatDuration(7260), '2h 01m');
  assert.equal(truncate('abcdefgh', 5), 'abcd…');
  assert.equal(sanitize('ok\x1b[31mred\x07'), 'ok[31mred');
});

test('server URL normalisation', () => {
  assert.deepEqual(normalizeServerUrl('mesh.example.com:444'), { base: 'https://mesh.example.com:444/', loginKey: null });
  assert.deepEqual(normalizeServerUrl('wss://mesh.example.com/control.ashx?key=abc'), { base: 'https://mesh.example.com/', loginKey: 'abc' });
  assert.equal(normalizeServerUrl('https://mesh.example.com/tenant').base, 'https://mesh.example.com/tenant/');
  assert.throws(() => normalizeServerUrl('ftp://x'), /Unsupported URL scheme/);
  assert.throws(() => normalizeServerUrl('https://user:pw@x'), /credentials/);
  assert.throws(() => normalizeServerUrl(''), /empty/);
});

test('derived URLs keep domain path and login key', () => {
  const s = { base: 'https://h:444/tenant/', loginKey: 'k1' };
  assert.equal(controlUrl(s), 'wss://h:444/tenant/control.ashx?key=k1');
  assert.equal(relayUrl(s, { p: 5, id: 'x', auth: 'a b' }), 'wss://h:444/tenant/meshrelay.ashx?p=5&id=x&auth=a+b&key=k1');
  assert.equal(agentRelayPath(s, { p: 1, nodeid: 'node//a@b', id: 'z' }), '*/tenant/meshrelay.ashx?p=1&nodeid=node%2F%2Fa%40b&id=z');
  const web = new URL(deviceWebUrl(s, { nodeId: 'node//abc$def', view: VIEW.desktop, hide: HIDE.header | HIDE.tabs, login: 'L' }));
  assert.equal(web.searchParams.get('node'), 'abc$def');
  assert.equal(web.searchParams.get('viewmode'), '11');
  assert.equal(web.searchParams.get('hide'), '3');
  assert.equal(web.searchParams.get('login'), 'L');
  assert.equal(web.searchParams.get('key'), 'k1');
  assert.equal(shortNodeId('node/dom/xyz'), 'xyz');
});

test('OS detection', () => {
  assert.equal(detectOs({ osdesc: 'Microsoft Windows 11 Pro' }), 'windows');
  assert.equal(detectOs({ osdesc: 'Ubuntu 24.04.1 LTS' }), 'linux');
  assert.equal(detectOs({ osdesc: 'macOS 26.6' }), 'macos');
  assert.equal(detectOs({ agent: { id: 4 } }), 'windows');
  assert.equal(detectOs({ agent: { id: 29 } }), 'macos');
  assert.equal(detectOs({ agent: { id: 6 } }), 'linux');
  assert.equal(detectOs({ osdesc: 'Microsoft Hyper-V Server - 17763', agent: { id: 4 } }), 'windows'); // real device from the field
  assert.equal(detectOs({ osdesc: 'Microsoft Hyper-V Server - 17763' }), 'windows');
  assert.equal(detectOs({ osdesc: 'Ubuntu 24.04', agent: { id: 6 } }), 'linux');
  assert.equal(detectOs({}), 'unknown');
});

test('device normalisation and matching', () => {
  const devices = normalizeDevices({ meshes: [{ _id: 'mesh//g1', name: 'Office' }], nodes: { ...MOCK_NODES, 'mesh//g2': [{ _id: 'node//x', name: 'Lenovo30', conn: 1 }, { _id: 'node//y', name: 'Café PC', conn: 0 }] } });
  assert.equal(devices.length, 4);
  const lenovo = devices.find((d) => d.name === 'Lenovo3');
  assert.equal(lenovo.group, 'Office');
  assert.equal(lenovo.online, true);
  assert.equal(lenovo.os, 'windows');
  // exact beats prefix even though "Lenovo30" also starts with it
  assert.deepEqual(matchDevices(devices, 'lenovo3').matches.map((d) => d.name), ['Lenovo3']);
  assert.deepEqual(matchDevices(devices, 'LEN').matches.map((d) => d.name).sort(), ['Lenovo3', 'Lenovo30']);
  assert.equal(matchDevices(devices, 'cafe').matches[0].name, 'Café PC'); // accent-insensitive
  assert.equal(matchDevices(devices, 'pc').level, 'contains');
  assert.equal(matchDevices(devices, 'id:win1').matches[0].name, 'Lenovo3');
  assert.equal(matchDevices(devices, 'nothing').matches.length, 0);
  assert.deepEqual(filterDevices(devices, { os: 'linux' }).map((d) => d.name), ['ubuntu26']);
  assert.deepEqual(filterDevices(devices, { online: false }).map((d) => d.name).sort(), ['Café PC', 'ubuntu26']);
  assert.deepEqual(filterDevices(devices, { group: 'off' }).map((d) => d.name).sort(), ['Lenovo3', 'ubuntu26']);
});

test('argument parsing', () => {
  assert.deepEqual(splitCommand(['-p', 'work', 'list']), { index: 2, word: 'list' });
  assert.deepEqual(splitCommand(['--no-color']), { index: -1, word: null });
  const spec = { positionals: [{ name: 'device', required: true }, { name: 'rest', rest: true }], options: { force: { type: 'boolean', short: 'f' } } };
  const r = parseCommandArgs(['Lenovo 3', 'a', 'b', '-f', '--timeout', '5'], spec);
  assert.equal(r.args.device, 'Lenovo 3');
  assert.deepEqual(r.args.rest, ['a', 'b']);
  assert.equal(r.opts.force, true);
  assert.equal(r.opts.timeout, 5000);
  assert.throws(() => parseCommandArgs(['--nope'], spec), /Unknown option '--nope'\./);
  assert.throws(() => parseCommandArgs([], spec), /Missing argument <device>/);
  assert.throws(() => parseCommandArgs(['x', '--timeout', '-1'], spec), /timeout/);
  assert.throws(() => parseCommandArgs(['a', 'b'], { positionals: [{ name: 'one' }] }), /Unexpected argument "b"/);
});

test('completion engine', () => {
  const data = { commands: ['list', 'shell', 'upload', 'download', 'web', 'profile'], deviceNames: (p) => (p === 'work' ? ['WorkPC'] : ['Lenovo3', 'Lenovo4', 'ubuntu26', 'My Laptop']), profiles: () => ['default', 'work'] };
  assert.deepEqual(complete(['len'], 1, data), ['Lenovo3', 'Lenovo4']);
  assert.deepEqual(complete(['we'], 1, data), ['web']);
  assert.deepEqual(complete(['web', 'LEN'], 2, data), ['Lenovo3', 'Lenovo4']);
  assert.deepEqual(complete(['web', 'lap'], 2, data), ['My Laptop']); // substring fallback
  assert.deepEqual(complete(['upload', 'Lenovo3', ''], 3, data), [':files']);
  assert.deepEqual(complete(['upload', 'Lenovo3', 'a.txt', ''], 4, data), [':files']);
  assert.deepEqual(complete(['download', 'Lenovo3', ''], 3, data), []);
  assert.deepEqual(complete(['download', 'Lenovo3', 'C:\\x', ''], 4, data), [':files']);
  assert.deepEqual(complete(['-p', 'work', 'shell', ''], 4, data), ['WorkPC']);
  assert.deepEqual(complete(['-p', ''], 2, data), ['default', 'work']);
  assert.deepEqual(complete(['list', '--os', ''], 3, data), ['windows', 'linux', 'macos', 'freebsd', 'android']);
  assert.deepEqual(complete(['Lenovo3', ''], 2, data), []);
  assert.deepEqual(complete(['shell', '"My'], 2, data), ['My Laptop']);
  assert.deepEqual(complete(['profile', 'u'], 2, data), ['use']);
});

test('rc file patching is idempotent and disables the prototype line', () => {
  const legacy = 'export PATH=x\n# Mesh CLI\nsource "$HOME/.config/mesh-cli/mesh.zsh"\n';
  const line = sourceLine('zsh', '/home/u/.config/meshcli/completion/mesh.zsh');
  const once = patchRcText(legacy, line);
  assert.equal(once.changedLegacy, true);
  assert.match(once.text, /# source "\$HOME\/\.config\/mesh-cli\/mesh\.zsh"/);
  assert.equal(once.text.split('\n').filter((l) => l.includes(MARKER)).length, 1);
  const twice = patchRcText(once.text, line);
  assert.equal(twice.text, once.text);
  assert.equal(twice.changedLegacy, false);
  assert.ok(!unpatchRcText(twice.text).includes(MARKER));
  assert.equal(sourceLine('powershell', "C:\\O'Brien\\mesh.ps1"), `if (Test-Path 'C:\\O''Brien\\mesh.ps1') { . 'C:\\O''Brien\\mesh.ps1' } ${MARKER}`);
  assert.match(sourceLine('bash', '/a b/$x'), /"\/a b\/\\\$x"/);
});

test('badges have fixed width with and without colour', () => {
  configureTerminal({ color: false });
  for (const k of ['ok', 'fail', 'warn', 'skip', 'info']) assert.equal(visibleWidth(badge(k)), BADGE_WIDTH);
  assert.equal(badge('ok'), '  OK  ');
  assert.equal(badge('skip'), ' SKIP ');
  configureTerminal({ color: true });
  assert.match(badge('fail'), /\x1b\[41;97m FAIL \x1b\[0m/);
  assert.equal(visibleWidth(badge('ok')), BADGE_WIDTH);
  configureTerminal({ color: false });
  assert.equal(detectColor({ flag: false }), false);
  assert.equal(detectColor({ env: { NO_COLOR: '1' }, stream: { isTTY: true } }), false);
  assert.equal(detectColor({ env: { FORCE_COLOR: '1' }, stream: { isTTY: false } }), true);
  assert.equal(detectColor({ env: { TERM: 'dumb' }, stream: { isTTY: true } }), false);
  assert.equal(detectColor({ env: {}, stream: { isTTY: true } }), true);
});

test('picker filtering and paging', () => {
  const items = ['Lenovo3', 'ubuntu26', 'Lenovo4', 'MyLaptop'].map((n) => ({ label: n, value: n }));
  assert.deepEqual(filterItems(items, 'len').map((i) => i.value), ['Lenovo3', 'Lenovo4']);
  assert.deepEqual(filterItems(items, 'u26').map((i) => i.value), ['ubuntu26']); // subsequence
  assert.deepEqual(filterItems(items, 'top').map((i) => i.value), ['MyLaptop']);
  const many = Array.from({ length: 30 }, (_, i) => ({ label: `dev${String(i).padStart(2, '0')}`, value: i }));
  const r = renderPicker({ title: 'Pick', query: '', items: many, selected: 20, pageSize: 5 });
  assert.equal(r.selected, 20);
  assert.ok(r.lines.some((l) => stripAnsi(l).includes('dev20')));
  assert.ok(stripAnsi(r.lines.at(-1)).includes('of 30'));
  assert.ok(renderPicker({ title: 'x', query: 'zzz', items: many, selected: 0, pageSize: 5 }).lines.some((l) => stripAnsi(l).includes('No matches')));
});

test('progress never invents a percentage', () => {
  let now = 0;
  const known = new TransferProgress({ label: 'f', total: 1000, stream: { isTTY: false }, now: () => now });
  now = 1000; known.update(500);
  assert.match(stripAnsi(known.line(100)), /50%/);
  assert.match(stripAnsi(known.line(100)), /ETA/);
  const unknown = new TransferProgress({ label: 'f', total: null, stream: { isTTY: false }, now: () => now });
  now = 2000; unknown.update(500);
  assert.doesNotMatch(stripAnsi(unknown.line(100)), /%|ETA/);
});

test('files protocol helpers', () => {
  assert.deepEqual([...encodeUploadChunk(Buffer.from([0, 1]))], [0, 0, 1]);
  assert.deepEqual([...encodeUploadChunk(Buffer.from('{x'))], [0, 123, 120]);
  assert.deepEqual([...encodeUploadChunk(Buffer.from('ab'))], [97, 98]);
  const win = remotePath('windows');
  assert.equal(win.join('C:\\Temp', 'a.txt'), 'C:\\Temp\\a.txt');
  assert.equal(win.basename('C:\\Temp\\log.txt'), 'log.txt');
  assert.equal(win.normalize('C:/Temp/x'), 'C:\\Temp\\x');
  assert.equal(remotePath('linux').dirname('/var/log/syslog'), '/var/log');
  assert.deepEqual(entryFromAgent({ n: 'C:', t: 1, s: 100, f: 50 }), { name: 'C:', type: 'drive', size: 100, mtime: null, free: 50 });
  assert.equal(safeLocalName('a:b?.txt'), 'a_b_.txt');
  assert.equal(safeLocalName('..'), '_');
  assert.deepEqual(splitWords('get "My File.txt" ./out'), ['get', 'My File.txt', './out']);
});

test('auth header and server close messages', () => {
  const h = meshAuthHeader({ user: 'mm', password: 'p,ä', token: '123456' }).split(',');
  assert.deepEqual(h.map((x) => Buffer.from(x, 'base64').toString()), ['mm', 'p,ä', '123456']);
  assert.equal(closeMessageToError({ cause: 'noauth', msg: 'tokenrequired' }).reason, 'tokenrequired');
  assert.equal(closeMessageToError({ cause: 'noauth', msg: 'noauth' }).reason, 'invalid');
  assert.equal(closeMessageToError({ cause: 'banned' }).reason, 'banned');
  assert.equal(closeMessageToError({ cause: 'noauth', msg: 'tokenrequired' }).exitCode, 3);
});

test('shell protocol selection', () => {
  const win = { name: 'w', os: 'windows' };
  const lin = { name: 'l', os: 'linux' };
  assert.deepEqual(shellProtocol(win), { protocol: 6, label: 'PowerShell' });
  assert.deepEqual(shellProtocol(win, { flavour: 'cmd' }), { protocol: 1, label: 'Command Prompt' });
  assert.equal(shellProtocol(win, { asUser: true }).protocol, 9);
  assert.deepEqual(shellProtocol(lin), { protocol: 1, label: 'Shell' });
  assert.equal(shellProtocol(lin, { asUser: true }).protocol, 8);
  assert.throws(() => shellProtocol(lin, { flavour: 'powershell' }), /only available on Windows/);
});

test('misc', () => {
  assert.equal(normalizeFingerprint('0e2be1a4'), '0E:2B:E1:A4');
  assert.equal(closestCommand('lsit'), 'list');
  assert.equal(closestCommand('uplaod'), 'upload');
  assert.equal(closestCommand('Lenovo3'), null);
});

test('src/version.js matches package.json', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { VERSION } = await import('../src/version.js');
  assert.equal(VERSION, pkg.version);
});

test('launcher scripts require Node and never embed it', async () => {
  const { launcherScript } = await import('../src/commands/selfinstall.js');
  const unix = launcherScript('/home/u/.local/share/meshcli/mesh.cjs', 'linux');
  assert.match(unix, /^#!\/bin\/sh\n/);
  assert.match(unix, /command -v node/);
  assert.match(unix, /Node\.js 18\.17 or newer is required/);
  assert.match(unix, /exec node "\/home\/u\/\.local\/share\/meshcli\/mesh\.cjs" "\$@"/);
  assert.match(launcherScript('/a "b"/$x/mesh.cjs', 'linux'), /exec node "\/a \\"b\\"\/\\\$x\/mesh\.cjs"/);
  const win = launcherScript('C:\\Users\\u\\AppData\\Local\\Programs\\MeshCLI\\mesh.cjs', 'win32');
  assert.match(win, /where node/);
  assert.match(win, /node "C:\\Users\\u\\AppData\\Local\\Programs\\MeshCLI\\mesh\.cjs" %\*/);
  assert.ok(win.includes('\r\n'));
});

test('PowerShell CLIXML errors become one readable line', async () => {
  const { cleanPsError } = await import('../src/auth/keyring.js');
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><MS><I64 N="SourceId">1</I64></MS></Obj><S S="Error">Exception calling "Write" with "3" argument(s): "A specified logon session does not exist. It may already have been _x000D__x000A_</S><S S="Error">terminated"_x000D__x000A_</S><S S="Error">At line:24 char:58_x000D__x000A_</S><S S="Error">+ ... eadToEnd(); [MeshCliCred]::Write(_x000D__x000A_</S></Objs>';
  assert.equal(cleanPsError(clixml), 'Exception calling "Write" with "3" argument(s): "A specified logon session does not exist. It may already have been terminated"');
  assert.equal(cleanPsError('plain error\n'), 'plain error');
  assert.equal(cleanPsError(''), '');
});
