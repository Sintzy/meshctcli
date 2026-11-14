// install / uninstall: put the standalone executable on the PATH (and take it off again).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as t from '../ui/term.js';
import { install as installCompletion, uninstall as uninstallCompletion, detectShell, rcFileFor, LEGACY_PATTERN } from '../completion/install.js';
import { loadConfig } from '../config/config.js';
import { paths } from '../config/paths.js';
import { deleteStored } from '../auth/credentials.js';
import { confirm, isInteractive } from '../ui/prompt.js';
import { MeshError, UsageError, CancelledError } from '../errors.js';

const PATH_MARKER = '# MeshCLI path';
const isWindows = process.platform === 'win32';
const exeName = isWindows ? 'mesh.exe' : 'mesh';

export const defaultInstallDir = () => (isWindows
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'MeshCLI')
  : path.join(os.homedir(), '.local', 'bin'));

const onPath = (dir) => (process.env.PATH || '').split(path.delimiter).some((p) => p && path.resolve(p) === path.resolve(dir));

function powershell(script, env) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });
}

function addToPath(dir) {
  const actions = [];
  if (isWindows) {
    const r = powershell("$p=[Environment]::GetEnvironmentVariable('Path','User'); if (($p -split ';') -notcontains $env:MESHCLI_DIR) { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $env:MESHCLI_DIR).TrimStart(';'), 'User') }", { MESHCLI_DIR: dir });
    if (r.status !== 0) throw new MeshError(`Could not add ${dir} to the user PATH: ${r.stderr.trim()}`);
    actions.push(`added ${dir} to your user PATH`);
    return actions;
  }
  const shell = detectShell();
  const rc = rcFileFor(shell);
  if (!rc || shell === 'fish') {
    if (shell === 'fish') { actions.push(`run: fish_add_path ${dir}`); }
    return actions;
  }
  const text = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
  if (!text.includes(PATH_MARKER)) {
    fs.appendFileSync(rc, `${text && !text.endsWith('\n') ? '\n' : ''}export PATH="${dir}:$PATH" ${PATH_MARKER}\n`);
    actions.push(`added ${dir} to PATH in ${rc}`);
  }
  return actions;
}

function removeFromPath(dir) {
  const actions = [];
  if (isWindows) {
    const r = powershell("$p=[Environment]::GetEnvironmentVariable('Path','User'); $n=(($p -split ';') | Where-Object { $_ -and $_ -ne $env:MESHCLI_DIR }) -join ';'; [Environment]::SetEnvironmentVariable('Path', $n, 'User')", { MESHCLI_DIR: dir });
    if (r.status === 0) actions.push('removed MeshCLI from your user PATH');
    return actions;
  }
  for (const shell of ['zsh', 'bash']) {
    const rc = rcFileFor(shell);
    if (!rc || !fs.existsSync(rc)) continue;
    const text = fs.readFileSync(rc, 'utf8');
    if (!text.includes(PATH_MARKER)) continue;
    fs.writeFileSync(rc, text.split('\n').filter((l) => !l.includes(PATH_MARKER)).join('\n'));
    actions.push(`removed the MeshCLI PATH line from ${rc}`);
  }
  return actions;
}

export const installCmd = {
  name: 'install',
  summary: 'Install this executable as "mesh" on your PATH, with Tab completion',
  usage: 'mesh install [--dir folder] [--no-completion]',
  options: { dir: { type: 'string' }, 'no-completion': { type: 'boolean' } },
  async run(_ctx, { opts }) {
    if (!process.env.MESHCLI_BUNDLED) throw new UsageError('"mesh install" is only for the standalone executable.', { hint: 'You are running from source/npm; use "npm install -g ." and "mesh completion install" instead.' });
    const dir = path.resolve(opts.dir || defaultInstallDir());
    const dest = path.join(dir, exeName);
    t.title('MeshCLI', `Installing to ${dir}`);
    fs.mkdirSync(dir, { recursive: true });
    if (path.resolve(process.execPath) !== dest) {
      const tmp = `${dest}.new`;
      fs.copyFileSync(process.execPath, tmp);
      fs.chmodSync(tmp, 0o755);
      try { fs.renameSync(tmp, dest); } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw new MeshError(`Cannot replace ${dest}: ${err.message}`, { hint: 'Close other running "mesh" sessions and try again.' });
      }
    }
    t.status('ok', `Installed ${dest}`);
    if (!onPath(dir)) for (const a of addToPath(dir)) t.status('ok', a);
    if (!opts['no-completion']) {
      const r = installCompletion();
      for (const a of r.actions) t.status('ok', a);
    }
    t.result('ok', 'MeshCLI installed.');
    t.detail(`Open a new terminal, then run: mesh configure${onPath(dir) ? '' : '   (PATH changes apply to new terminals)'}`, 7);
  },
};

function removeLegacyPrototype() {
  const actions = [];
  const rc = path.join(process.env.ZDOTDIR || os.homedir(), '.zshrc');
  try {
    const text = fs.readFileSync(rc, 'utf8');
    if (LEGACY_PATTERN.test(text) || /mesh-cli\/mesh\.zsh/.test(text)) {
      fs.copyFileSync(rc, `${rc}.meshcli.bak`);
      const cleaned = text.split('\n').filter((l) => !/mesh-cli\/mesh\.zsh/.test(l) && l.trim() !== '# Mesh CLI').join('\n');
      fs.writeFileSync(rc, cleaned);
      actions.push(`removed the old prototype lines from ${rc}`);
    }
  } catch { /* no rc file */ }
  const old = path.join(os.homedir(), '.config', 'mesh-cli');
  if (fs.existsSync(old)) { fs.rmSync(old, { recursive: true, force: true }); actions.push(`removed ${old}`); }
  return actions;
}

export const uninstallCmd = {
  name: 'uninstall',
  summary: 'Remove MeshCLI: executable, PATH entry, completion (--purge: also settings and credentials)',
  usage: 'mesh uninstall [--purge] [--yes]',
  options: { purge: { type: 'boolean' } },
  async run(_ctx, { opts }) {
    const dir = path.dirname(process.execPath);
    const bundled = Boolean(process.env.MESHCLI_BUNDLED);
    if (!opts.yes) {
      if (!isInteractive()) throw new UsageError('Refusing to uninstall without confirmation.', { hint: 'Pass --yes.' });
      t.print(`This removes ${bundled ? process.execPath : 'shell integration'}, the PATH entry and Tab completion${opts.purge ? `, ${t.c.bold('all profiles, stored logins and caches')}` : ''}.`);
      if (!(await confirm('Continue?', { default: false }))) throw new CancelledError();
    }
    const actions = [];
    for (const shell of ['zsh', 'bash', 'fish', 'powershell']) { try { actions.push(...uninstallCompletion(shell).actions); } catch { /* shell not present */ } }
    actions.push(...removeLegacyPrototype());
    if (opts.purge) {
      try {
        const config = loadConfig();
        for (const [name, profile] of Object.entries(config.profiles)) { try { if (deleteStored(name, profile)) actions.push(`removed stored login of profile "${name}"`); } catch { /* ignore */ } }
      } catch { /* unreadable config: still purge the folder */ }
      if (fs.existsSync(paths.config)) { fs.rmSync(paths.config, { recursive: true, force: true }); actions.push(`removed ${paths.config}`); }
    }
    if (bundled) {
      actions.push(...removeFromPath(dir));
      if (isWindows) actions.push(`delete ${process.execPath} manually after this window closes (Windows keeps running programs locked)`);
      else { fs.rmSync(process.execPath, { force: true }); actions.push(`removed ${process.execPath}`); }
    }
    for (const a of actions) t.status('ok', a);
    t.result('ok', actions.length ? 'MeshCLI removed.' : 'Nothing to remove.');
    t.detail('Server-side login tokens stay valid until revoked: MeshCentral > My Account > Login Tokens.', 7);
  },
};
