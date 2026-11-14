// upload, download, files (listing + interactive explorer)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import * as t from '../ui/term.js';
import { FileSession } from '../session/files.js';
import { TransferProgress, spinner } from '../ui/progress.js';
import { formatBytes, formatDuration, sanitize } from '../ui/format.js';
import { MeshError, UsageError, EXIT } from '../errors.js';
import { confirm, isInteractive } from '../ui/prompt.js';

async function openFiles(ctx, deviceQuery) {
  const device = await ctx.device(deviceQuery, { requireOnline: true });
  const client = await ctx.client();
  const s = process.stderr.isTTY ? spinner(`Opening file session on ${sanitize(device.name)}…`) : null;
  try {
    const session = await FileSession.open(client, device, { onStatus: (m) => s?.update(sanitize(m)) });
    return { device, session };
  } finally { s?.stop(); }
}

/** Upload one local file (also used by the explorer). */
async function doUpload(session, device, localFile, remoteDir, { force, confirmFn = confirm }) {
  const stat = fs.statSync(localFile);
  if (!stat.isFile()) throw new UsageError(`${localFile} is not a regular file.`);
  const rp = session.rp;
  const dir = rp.normalize(remoteDir);
  const name = path.basename(localFile);
  const entries = await session.ls(dir);
  if (entries === null) throw new MeshError(`Remote folder ${dir} does not exist on ${device.name}.`, { exitCode: EXIT.NOT_FOUND });
  const existing = entries.find((e) => (device.os === 'windows' ? e.name.toLowerCase() === name.toLowerCase() : e.name === name));
  if (existing && existing.type !== 'file') throw new MeshError(`${rp.join(dir, name)} exists and is a ${existing.type}.`);
  if (existing && !force) {
    if (!isInteractive() || !(await confirmFn(`${rp.join(dir, name)} already exists (${formatBytes(existing.size)}). Overwrite?`, { default: false }))) {
      throw new MeshError(`Not overwriting ${rp.join(dir, name)}.`, { exitCode: EXIT.CANCELLED, hint: 'Use --force to overwrite.' });
    }
  }
  const progress = new TransferProgress({ label: name, total: stat.size });
  const bytes = await session.upload(localFile, dir, name, { onProgress: (b) => progress.update(b) });
  const r = progress.finish();
  if (bytes !== stat.size) throw new MeshError(`Upload incomplete: ${bytes} of ${stat.size} bytes acknowledged.`);
  t.status('ok', `Uploaded ${t.c.bold(name)} ${t.sym.arrow} ${sanitize(device.name)}:${rp.join(dir, name)} ${t.c.dim(`(${formatBytes(bytes)} in ${formatDuration(r.seconds)}, ${formatBytes(r.rate)}/s)`)}`);
}

async function doDownload(session, device, remoteFile, localTarget, { force, confirmFn = confirm }) {
  const rp = session.rp;
  const remote = rp.normalize(remoteFile);
  const entry = await session.stat(remote);
  if (!entry) throw new MeshError(`${remote} was not found on ${device.name}.`, { exitCode: EXIT.NOT_FOUND });
  if (entry.type !== 'file') throw new MeshError(`${remote} is a ${entry.type}; only files can be downloaded.`);
  let dest = path.resolve(localTarget || '.');
  if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) dest = path.join(dest, safeLocalName(rp.basename(remote)));
  if (!fs.existsSync(path.dirname(dest))) throw new UsageError(`Local folder ${path.dirname(dest)} does not exist.`);
  if (fs.existsSync(dest) && !force) {
    if (!isInteractive() || !(await confirmFn(`${dest} already exists. Overwrite?`, { default: false }))) {
      throw new MeshError(`Not overwriting ${dest}.`, { exitCode: EXIT.CANCELLED, hint: 'Use --force to overwrite.' });
    }
  }
  const progress = new TransferProgress({ label: rp.basename(remote), total: entry.size });
  const bytes = await session.download(remote, dest, { overwrite: true, onProgress: (b) => progress.update(b) });
  const r = progress.finish();
  if (entry.size !== null && bytes !== entry.size) t.status('warn', `Size differs from the listing (${formatBytes(entry.size)}); the file may have changed during the transfer.`);
  t.status('ok', `Downloaded ${t.c.bold(rp.basename(remote))} ${t.sym.arrow} ${dest} ${t.c.dim(`(${formatBytes(bytes)} in ${formatDuration(r.seconds)}, ${formatBytes(r.rate)}/s)`)}`);
}

/** Make a remote file name safe for the local file system. */
export function safeLocalName(name) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+$/, '_');
  return cleaned || 'download';
}

export const upload = {
  name: 'upload',
  aliases: ['put'],
  summary: 'Upload local file(s) to a remote folder',
  usage: 'mesh upload <device> <local-file>... <remote-folder> [--force]',
  positionals: [{ name: 'rest', rest: true }],
  options: { force: { type: 'boolean', short: 'f' } },
  async run(ctx, { args, opts }) {
    const [deviceQuery, ...rest] = args.rest;
    if (!deviceQuery || rest.length < 2) throw new UsageError('Usage: mesh upload <device> <local-file>... <remote-folder>', { hint: 'Example: mesh upload Lenovo3 ./report.pdf "C:\\Temp"' });
    const remoteDir = rest.pop();
    for (const f of rest) if (!fs.existsSync(f)) throw new UsageError(`Local file not found: ${f}`);
    const { device, session } = await openFiles(ctx, deviceQuery);
    try { for (const f of rest) await doUpload(session, device, f, remoteDir, opts); } finally { session.close(); }
  },
};

export const download = {
  name: 'download',
  aliases: ['get'],
  summary: 'Download a remote file',
  usage: 'mesh download <device> <remote-file> [local-path] [--force]',
  positionals: [{ name: 'device', required: true }, { name: 'remote', required: true }, { name: 'local' }],
  options: { force: { type: 'boolean', short: 'f' } },
  async run(ctx, { args, opts }) {
    const { device, session } = await openFiles(ctx, args.device);
    try { await doDownload(session, device, args.remote, args.local, opts); } finally { session.close(); }
  },
};

function printListing(entries) {
  if (!entries.length) { t.detail('(empty)', 2); return; }
  const sorted = [...entries].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'file' ? 1 : -1));
  t.table(sorted.map((e) => ({
    type: e.type === 'file' ? '' : e.type === 'drive' ? 'drive' : 'dir',
    size: e.type === 'file' ? formatBytes(e.size) : e.type === 'drive' && e.size ? `${formatBytes(e.free)} free of ${formatBytes(e.size)}` : '',
    date: e.mtime && !Number.isNaN(e.mtime.getTime()) ? e.mtime.toISOString().slice(0, 16).replace('T', ' ') : '',
    name: sanitize(e.name),
  })), [
    { key: 'type', label: 'Type', color: (v) => t.c.cyan(v) }, { key: 'size', label: 'Size' }, { key: 'date', label: 'Modified', color: (v) => t.c.dim(v) },
    { key: 'name', label: 'Name', color: (v, r) => (r.type ? t.c.bold(t.c.blue(v)) : v) },
  ]);
}

export const files = {
  name: 'files',
  aliases: ['explore'],
  summary: 'Browse remote files (interactive explorer, or --list for one folder)',
  usage: 'mesh files <device> [remote-folder] [--list] [--json]',
  positionals: [{ name: 'device' }, { name: 'path' }],
  options: { list: { type: 'boolean', short: 'l' } },
  async run(ctx, { args, opts }) {
    const { device, session } = await openFiles(ctx, args.device);
    const rp = session.rp;
    let cwd = args.path ? rp.normalize(args.path) : device.os === 'windows' ? '' : '/';
    try {
      if (opts.list || opts.json || !isInteractive()) {
        const entries = await session.ls(cwd);
        if (entries === null) throw new MeshError(`${cwd || '/'} does not exist on ${device.name}.`, { exitCode: EXIT.NOT_FOUND });
        if (opts.json) t.print(JSON.stringify(entries, null, 2));
        else { t.title(`${sanitize(device.name)}:${cwd || '(drives)'}`); t.print(); printListing(entries); }
        return;
      }
      await explorer(session, device, cwd);
    } finally { session.close(); }
  },
};

const EXPLORER_HELP = [
  ['ls [folder]', 'list a folder'], ['cd <folder>', 'change folder (.. for parent, / or empty for root)'], ['pwd', 'show the current folder'],
  ['get <file> [local]', 'download a file'], ['put <local> [folder]', 'upload a file'], ['mkdir <name>', 'create a folder'],
  ['rm <name>', 'delete a file or folder (asks first)'], ['exit', 'leave the explorer'],
];

/** Split a command line honouring double quotes (no shell evaluation). */
export function splitWords(line) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

async function explorer(session, device, start) {
  const rp = session.rp;
  let cwd = start;
  let cache = [];
  const resolve = (p) => {
    if (!p || p === '.') return cwd;
    if (p === '/' && device.os === 'windows') return '';
    if (p === '..') { if (device.os === 'windows' && /^[A-Za-z]:\\?$/.test(cwd)) return ''; const d = rp.dirname(cwd); return d === cwd ? cwd : d; }
    if (rp.isAbsolute(p)) return rp.normalize(device.os === 'windows' && /^[A-Za-z]:$/.test(p) ? `${p}\\` : p);
    return cwd ? rp.join(cwd, p) : rp.normalize(device.os === 'windows' && /^[A-Za-z]:$/.test(p) ? `${p}\\` : p);
  };
  const list = async (dir) => {
    const entries = await session.ls(dir);
    if (entries === null) { t.status('fail', `${dir || '/'} not found.`); return null; }
    if (dir === cwd) cache = entries;
    return entries;
  };
  t.title(`File explorer ${t.sym.dot} ${sanitize(device.name)}`, 'Type "help" for commands. Tab completes names in the current folder.');
  cache = (await list(cwd)) || [];
  const rl = readline.createInterface({
    input: process.stdin, output: process.stderr, terminal: true,
    completer: (line) => {
      const words = splitWords(line);
      const last = /\s$/.test(line) ? '' : words.pop() || '';
      const hits = cache.map((e) => e.name).filter((n) => n.toLowerCase().startsWith(last.toLowerCase())).map((n) => (n.includes(' ') ? `"${n}"` : n));
      return [hits, last];
    },
  });
  const rlConfirm = (text) => new Promise((res) => rl.question(`${t.c.cyan('?')} ${text} ${t.c.dim('[y/N]')} `, (ans) => res(/^(y|yes)$/i.test(ans.trim()))));
  const prompt = () => rl.setPrompt(`${t.c.cyan(sanitize(device.name))}:${t.c.bold(cwd || '(drives)')}${t.c.dim('>')} `);
  prompt(); rl.prompt();
  for await (const line of rl) {
    const [cmdWord, ...a] = splitWords(line.trim());
    try {
      switch ((cmdWord || '').toLowerCase()) {
        case '': break;
        case 'help': case '?': t.keyValues(EXPLORER_HELP); break;
        case 'exit': case 'quit': case 'q': rl.close(); return;
        case 'pwd': t.print(cwd || '(drives)'); break;
        case 'ls': case 'dir': { const e = await list(resolve(a[0])); if (e) printListing(e); break; }
        case 'cd': {
          const target = resolve(a[0] ?? '/');
          const e = await list(target);
          if (e) { cwd = target; cache = e; prompt(); }
          break;
        }
        case 'get': {
          if (!a[0]) { t.status('warn', 'Usage: get <file> [local-path]'); break; }
          await doDownload(session, device, resolve(a[0]), a[1] || '.', { force: false, confirmFn: rlConfirm });
          break;
        }
        case 'put': {
          if (!a[0]) { t.status('warn', 'Usage: put <local-file> [remote-folder]'); break; }
          await doUpload(session, device, a[0], a[1] ? resolve(a[1]) : cwd, { force: false, confirmFn: rlConfirm });
          cache = (await list(cwd)) || cache;
          break;
        }
        case 'mkdir': {
          if (!a[0]) { t.status('warn', 'Usage: mkdir <name>'); break; }
          session.mkdir(resolve(a[0]));
          await new Promise((r) => setTimeout(r, 300));
          cache = (await list(cwd)) || cache;
          t.status(cache.some((e) => e.name === a[0]) ? 'ok' : 'warn', cache.some((e) => e.name === a[0]) ? `Created ${a[0]}.` : 'Folder not visible yet (no permission?).');
          break;
        }
        case 'rm': case 'del': {
          if (!a[0]) { t.status('warn', 'Usage: rm <name>'); break; }
          const entry = cache.find((e) => e.name === a[0]);
          if (!entry) { t.status('fail', `${a[0]} not found in the current folder.`); break; }
          if (!(await rlConfirm(`Delete ${entry.type} ${rp.join(cwd, a[0])}${entry.type === 'dir' ? ' and everything in it' : ''}?`, { default: false }))) break;
          session.rm(cwd, [a[0]], { recursive: entry.type === 'dir' });
          await new Promise((r) => setTimeout(r, 300));
          cache = (await list(cwd)) || cache;
          t.status(cache.some((e) => e.name === a[0]) ? 'warn' : 'ok', cache.some((e) => e.name === a[0]) ? 'Still present (permission denied?).' : `Deleted ${a[0]}.`);
          break;
        }
        default: t.status('warn', `Unknown command "${cmdWord}". Type "help".`);
      }
    } catch (err) {
      t.status('fail', sanitize(err.message));
      if (session.closed) { rl.close(); throw err; }
    }
    rl.prompt();
  }
}
