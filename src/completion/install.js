// Install/uninstall shell completion: the script lives in the MeshCLI config folder and the shell
// start-up file gets exactly one marked line (fish needs none: it autoloads completion files).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, ensurePrivateDir } from '../config/paths.js';
import { SCRIPTS } from './scripts.js';
import { UsageError } from '../errors.js';

export const MARKER = '# MeshCLI completion';
// Line added by the earlier single-file prototype; it defines a "mesh" shell function that would
// shadow the installed command.
export const LEGACY_PATTERN = /^[^#\n]*\.config\/mesh-cli\/mesh\.zsh.*$/m;

export function detectShell(env = process.env, platform = process.platform) {
  if (platform === 'win32') return 'powershell';
  const sh = path.basename(env.SHELL || '');
  if (['zsh', 'bash', 'fish'].includes(sh)) return sh;
  if (env.PSModulePath && !env.SHELL) return 'powershell';
  return 'bash';
}

function powershellProfile() {
  for (const exe of process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh']) {
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserAllHosts'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

export function rcFileFor(shell, home = os.homedir()) {
  if (shell === 'zsh') return path.join(process.env.ZDOTDIR || home, '.zshrc');
  if (shell === 'bash') return path.join(home, '.bashrc');
  if (shell === 'powershell') return powershellProfile();
  return null;
}

const quote = (shell, p) => (shell === 'powershell' ? `'${p.replace(/'/g, "''")}'` : `"${p.replace(/(["\\$`])/g, '\\$1')}"`);

export function sourceLine(shell, scriptPath) {
  if (shell === 'powershell') return `if (Test-Path ${quote(shell, scriptPath)}) { . ${quote(shell, scriptPath)} } ${MARKER}`;
  return `[ -f ${quote(shell, scriptPath)} ] && source ${quote(shell, scriptPath)} ${MARKER}`;
}

/** Add our line to an rc file's text (idempotent); comment out the legacy prototype line. */
export function patchRcText(text, line) {
  let changedLegacy = false;
  let out = text.replace(LEGACY_PATTERN, (m) => { changedLegacy = true; return `# ${m}  # disabled by MeshCLI (replaced by the line below)`; });
  const lines = out.split('\n').filter((l) => !l.includes(MARKER));
  out = lines.join('\n');
  if (out.length && !out.endsWith('\n')) out += '\n';
  out += `${line}\n`;
  return { text: out, changedLegacy };
}

export function unpatchRcText(text) {
  return text.split('\n').filter((l) => !l.includes(MARKER)).join('\n');
}

export function install(shell = detectShell()) {
  if (!SCRIPTS[shell]) throw new UsageError(`Unsupported shell "${shell}". Use zsh, bash, fish or powershell.`);
  const actions = [];
  if (shell === 'fish') {
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'fish', 'completions');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['mesh', 'meshcli']) {
      const f = path.join(dir, `${name}.fish`);
      fs.writeFileSync(f, SCRIPTS.fish());
      actions.push(`wrote ${f}`);
    }
    return { shell, actions, reload: 'Open a new fish session.' };
  }
  ensurePrivateDir(paths.completionDir);
  const ext = shell === 'powershell' ? 'ps1' : shell;
  const scriptPath = path.join(paths.completionDir, `mesh.${ext}`);
  fs.writeFileSync(scriptPath, SCRIPTS[shell]());
  actions.push(`wrote ${scriptPath}`);
  const rc = rcFileFor(shell);
  if (!rc) return { shell, actions, manual: sourceLine(shell, scriptPath), reload: 'Add the line above to your shell start-up file.' };
  const before = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
  const { text, changedLegacy } = patchRcText(before, sourceLine(shell, scriptPath));
  if (text !== before) {
    if (before) fs.copyFileSync(rc, `${rc}.meshcli.bak`);
    fs.mkdirSync(path.dirname(rc), { recursive: true });
    fs.writeFileSync(rc, text);
    actions.push(`updated ${rc}${before ? ` (backup: ${rc}.meshcli.bak)` : ''}`);
    if (changedLegacy) actions.push('disabled the old prototype line (~/.config/mesh-cli/mesh.zsh)');
  } else actions.push(`${rc} already up to date`);
  return { shell, actions, reload: shell === 'powershell' ? 'Restart PowerShell.' : `Run: source ${rc}` };
}

export function uninstall(shell = detectShell()) {
  const actions = [];
  if (shell === 'fish') {
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'fish', 'completions');
    for (const name of ['mesh', 'meshcli']) { const f = path.join(dir, `${name}.fish`); if (fs.existsSync(f)) { fs.unlinkSync(f); actions.push(`removed ${f}`); } }
    return { shell, actions };
  }
  const rc = rcFileFor(shell);
  if (rc && fs.existsSync(rc)) {
    const before = fs.readFileSync(rc, 'utf8');
    const after = unpatchRcText(before);
    if (after !== before) { fs.writeFileSync(rc, after); actions.push(`removed the MeshCLI line from ${rc}`); }
  }
  const ext = shell === 'powershell' ? 'ps1' : shell;
  const scriptPath = path.join(paths.completionDir, `mesh.${ext}`);
  if (fs.existsSync(scriptPath)) { fs.unlinkSync(scriptPath); actions.push(`removed ${scriptPath}`); }
  return { shell, actions };
}

/** Is completion installed for this shell? */
export function isInstalled(shell = detectShell()) {
  if (shell === 'fish') return fs.existsSync(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'fish', 'completions', 'mesh.fish'));
  const rc = rcFileFor(shell);
  return Boolean(rc && fs.existsSync(rc) && fs.readFileSync(rc, 'utf8').includes(MARKER));
}

export function legacyIntegration() {
  const rc = path.join(process.env.ZDOTDIR || os.homedir(), '.zshrc');
  try { return LEGACY_PATTERN.test(fs.readFileSync(rc, 'utf8')) ? rc : null; } catch { return null; }
}
