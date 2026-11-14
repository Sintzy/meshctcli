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

/** Folder with the launcher (this folder goes on the PATH). */
export const defaultBinDir = () => (isWindows
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'MeshCLI')
  : path.join(os.homedir(), '.local', 'bin'));

/** Folder with mesh.cjs. On Windows it is the same folder as the launcher. */
export const defaultLibDir = () => (isWindows
  ? defaultBinDir()
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'meshcli'));

/** Text of the launcher that runs mesh.cjs with the Node.js found on the PATH. Node is required, never bundled. */
export function launcherScript(libFile, platform = process.platform) {
  if (platform === 'win32') {
    return `@echo off\r\nwhere node >nul 2>nul || (echo  FAIL   Node.js 18.17 or newer is required: https://nodejs.org/ 1>&2 & exit /b 1)\r\nnode "${libFile}" %*\r\n`;
  }
  const q = libFile.replace(/(["\\$`])/g, '\\$1');
  return `#!/bin/sh\ncommand -v node >/dev/null 2>&1 || { echo " FAIL   Node.js 18.17 or newer is required: https://nodejs.org/" >&2; exit 1; }\nexec node "${q}" "$@"\n`;
}

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
  summary: 'Install the "mesh" command (needs Node.js) and Tab completion',
  usage: 'mesh install [--dir folder] [--no-completion]',
  options: { dir: { type: 'string' }, 'no-completion': { type: 'boolean' } },
  async run(_ctx, { opts }) {
    const self = process.argv[1];
    if (!process.env.MESHCLI_BUNDLED || !self || !fs.existsSync(self)) {
      throw new UsageError('"mesh install" is only for the downloaded mesh.cjs file.', { hint: 'From source or npm use "npm install -g ." and "mesh completion install" instead.' });
    }
    const binDir = path.resolve(opts.dir || defaultBinDir());
    const libDir = opts.dir && !isWindows ? binDir : defaultLibDir();
    const libFile = path.join(libDir, 'mesh.cjs');
    const launcher = path.join(binDir, isWindows ? 'mesh.cmd' : 'mesh');
    t.title('MeshCLI', `Installing to ${binDir}`);
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(libDir, { recursive: true });
    if (path.resolve(self) !== libFile) fs.copyFileSync(self, libFile);
    const tmp = `${launcher}.new`;
    fs.writeFileSync(tmp, launcherScript(libFile), { mode: 0o755 });
    fs.renameSync(tmp, launcher);
    t.status('ok', `Installed ${launcher}`);
    t.detail(`Runs with Node.js ${process.version} (found on your PATH at run time)`, 7);
    if (!onPath(binDir)) for (const a of addToPath(binDir)) t.status('ok', a);
    if (!opts['no-completion']) {
      const r = installCompletion();
      for (const a of r.actions) t.status('ok', a);
    }
    t.result('ok', 'MeshCLI installed.');
    t.detail(`Open a new terminal, then run: mesh configure${onPath(binDir) ? '' : '   (PATH changes apply to new terminals)'}`, 7);
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
    const self = process.argv[1] || '';
    const bundled = Boolean(process.env.MESHCLI_BUNDLED);
    const binDir = defaultBinDir();
    if (!opts.yes) {
      if (!isInteractive()) throw new UsageError('Refusing to uninstall without confirmation.', { hint: 'Pass --yes.' });
      t.print(`This removes ${bundled ? 'the mesh command' : 'shell integration'}, the PATH entry and Tab completion${opts.purge ? `, ${t.c.bold('all profiles, stored logins and caches')}` : ''}.`);
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
      const launcher = path.join(binDir, isWindows ? 'mesh.cmd' : 'mesh');
      if (fs.existsSync(launcher)) { fs.rmSync(launcher, { force: true }); actions.push(`removed ${launcher}`); }
      const libFile = path.join(defaultLibDir(), 'mesh.cjs');
      if (path.resolve(self) !== libFile || !isWindows) {
        if (fs.existsSync(libFile)) { fs.rmSync(libFile, { force: true }); actions.push(`removed ${libFile}`); }
        if (!isWindows) { try { fs.rmdirSync(defaultLibDir()); } catch { /* not empty or gone */ } }
      } else actions.push(`delete ${libFile} manually after this window closes (Windows keeps running programs locked)`);
      actions.push(...removeFromPath(binDir));
    }
    for (const a of actions) t.status('ok', a);
    t.result('ok', actions.length ? 'MeshCLI removed.' : 'Nothing to remove.');
    t.detail('Server-side login tokens stay valid until revoked: MeshCentral > My Account > Login Tokens.', 7);
  },
};
