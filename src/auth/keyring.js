// OS credential storage without native modules.
//
//   macOS   -> Keychain via /usr/bin/security (secret written on stdin with "security -i", never in argv)
//   Windows -> Credential Manager via PowerShell + CredWrite/CredRead (secret passed on stdin)
//   Linux   -> Secret Service (GNOME Keyring, KWallet...) via secret-tool (secret passed on stdin)
//   file    -> opt-in fallback: JSON file with 0600 permissions (NOT encrypted)
//
// Every secret is stored as base64 text so that quoting is never an issue.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { paths, writePrivateFile } from '../config/paths.js';
import { MeshError } from '../errors.js';

const SERVICE = 'MeshCLI';

function run(cmd, args, { input, env } = {}) {
  const r = spawnSync(cmd, args, { input, env: env || process.env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

function hasCommand(cmd) {
  const probe = process.platform === 'win32' ? run('where', [cmd]) : run('/bin/sh', ['-c', 'command -v "$1"', 'sh', cmd]);
  return probe.status === 0;
}

const encode = (value) => Buffer.from(value, 'utf8').toString('base64');
const decode = (value) => Buffer.from(String(value).trim(), 'base64').toString('utf8');
const assertSafe = (s) => { if (!/^[A-Za-z0-9@._:+-]+$/.test(s)) throw new MeshError(`Unsafe keyring account name: ${s}`); return s; };

// ---------------------------------------------------------------- macOS
const macos = {
  name: 'macOS Keychain',
  id: 'keychain',
  available: () => process.platform === 'darwin' && fs.existsSync('/usr/bin/security'),
  get(account) {
    const r = run('/usr/bin/security', ['find-generic-password', '-a', assertSafe(account), '-s', SERVICE, '-w']);
    if (r.status === 44) return null; // item not found
    if (r.status !== 0) throw new MeshError(`Keychain read failed: ${r.stderr.trim() || `exit ${r.status}`}`);
    return decode(r.stdout);
  },
  set(account, secret) {
    const cmd = `add-generic-password -U -a "${assertSafe(account)}" -s "${SERVICE}" -l "MeshCLI (${account})" -j "MeshCentral credentials stored by MeshCLI" -w "${encode(secret)}"\n`;
    const r = run('/usr/bin/security', ['-i'], { input: cmd });
    if (r.status !== 0 || /error|could not/i.test(r.stderr)) throw new MeshError(`Keychain write failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  },
  delete(account) {
    const r = run('/usr/bin/security', ['delete-generic-password', '-a', assertSafe(account), '-s', SERVICE]);
    return r.status === 0;
  },
};

// ---------------------------------------------------------------- Windows
const WIN_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class MeshCliCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredRead(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);
  public static string Read(string target) { IntPtr p; if (!CredRead(target, 1, 0, out p)) return null;
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); } finally { CredFree(p); } }
  public static void Write(string target, string user, string secret) { var bytes = Encoding.Unicode.GetBytes(secret);
    var c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2; c.CredentialBlobSize = bytes.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
    try { if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); } finally { Marshal.FreeHGlobal(c.CredentialBlob); } }
}
"@
$op = $env:MESHCLI_CRED_OP; $target = $env:MESHCLI_CRED_TARGET
if ($op -eq 'get') { $v = [MeshCliCred]::Read($target); if ($v -eq $null) { exit 44 }; [Console]::Out.Write($v) }
elseif ($op -eq 'set') { $s = [Console]::In.ReadToEnd(); [MeshCliCred]::Write($target, $env:MESHCLI_CRED_USER, $s.Trim()) }
elseif ($op -eq 'delete') { if (-not [MeshCliCred]::CredDelete($target, 1, 0)) { exit 44 } }
`;

function winRun(op, account, input) {
  const encoded = Buffer.from(WIN_HELPER, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    input,
    env: { ...process.env, MESHCLI_CRED_OP: op, MESHCLI_CRED_TARGET: `${SERVICE}:${assertSafe(account)}`, MESHCLI_CRED_USER: account },
  });
}

const windows = {
  name: 'Windows Credential Manager',
  id: 'wincred',
  available: () => process.platform === 'win32',
  get(account) {
    const r = winRun('get', account);
    if (r.status === 44) return null;
    if (r.status !== 0) throw new MeshError(`Credential Manager read failed: ${r.stderr.trim() || `exit ${r.status}`}`);
    return decode(r.stdout);
  },
  set(account, secret) {
    const r = winRun('set', account, encode(secret));
    if (r.status !== 0) throw new MeshError(`Credential Manager write failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  },
  delete(account) { return winRun('delete', account).status === 0; },
};

// ---------------------------------------------------------------- Linux (Secret Service)
const linux = {
  name: 'Secret Service (secret-tool)',
  id: 'secret-service',
  available: () => process.platform !== 'darwin' && process.platform !== 'win32' && hasCommand('secret-tool') &&
    Boolean(process.env.DBUS_SESSION_BUS_ADDRESS || process.env.XDG_RUNTIME_DIR),
  get(account) {
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', assertSafe(account)]);
    if (r.status !== 0 || !r.stdout.trim()) {
      if (r.stderr.trim() && !/not found|No such/i.test(r.stderr)) throw new MeshError(`Secret Service read failed: ${r.stderr.trim()}`);
      return null;
    }
    return decode(r.stdout);
  },
  set(account, secret) {
    const r = run('secret-tool', ['store', `--label=MeshCLI (${account})`, 'service', SERVICE, 'account', assertSafe(account)], { input: encode(secret) });
    if (r.status !== 0) throw new MeshError(`Secret Service write failed: ${r.stderr.trim() || `exit ${r.status}`}`, { hint: 'Is a keyring daemon (gnome-keyring, KWallet) running and unlocked?' });
  },
  delete(account) { return run('secret-tool', ['clear', 'service', SERVICE, 'account', assertSafe(account)]).status === 0; },
};

// ---------------------------------------------------------------- plain file (explicit opt-in only)
function readFileStore() {
  try { return JSON.parse(fs.readFileSync(paths.insecureCredentials, 'utf8')); } catch { return {}; }
}
const file = {
  name: 'file (0600 permissions, not encrypted)',
  id: 'file',
  insecure: true,
  available: () => true,
  get(account) { const v = readFileStore()[account]; return v ? decode(v) : null; },
  set(account, secret) { const all = readFileStore(); all[account] = encode(secret); writePrivateFile(paths.insecureCredentials, JSON.stringify(all, null, 2)); },
  delete(account) {
    const all = readFileStore();
    if (!(account in all)) return false;
    delete all[account];
    writePrivateFile(paths.insecureCredentials, JSON.stringify(all, null, 2));
    return true;
  },
};

export const BACKENDS = { keychain: macos, wincred: windows, 'secret-service': linux, file };

/** The secure OS backend for this machine, or null if none is usable. */
export function systemKeyring() {
  for (const backend of [macos, windows, linux]) if (backend.available()) return backend;
  return null;
}

export function backendById(id) { return BACKENDS[id] || null; }
