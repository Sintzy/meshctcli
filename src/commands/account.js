// configure, login, logout, status, profile
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig, saveConfig, resolveProfile, validateProfileName, PROFILE_DEFAULTS } from '../config/config.js';
import { normalizeServerUrl, hostLabel } from '../mesh/url.js';
import { probeCertificate, leafFingerprint, normalizeFingerprint } from '../mesh/tls.js';
import { MeshClient } from '../mesh/client.js';
import { systemKeyring, BACKENDS, fallbackKeyring } from '../auth/keyring.js';
import { loadStored, saveStored, deleteStored, resolveCredentials, backendFor } from '../auth/credentials.js';
import { readDeviceCache, clearDeviceCache } from '../mesh/cache.js';
import { installedBrowsers, BROWSERS } from '../browser/browser.js';
import * as t from '../ui/term.js';
import { ask, secret, confirm, isInteractive } from '../ui/prompt.js';
import { pick } from '../ui/picker.js';
import { withSpinner } from '../ui/progress.js';
import { formatRelativeTime } from '../ui/format.js';
import { AuthError, MeshError, UsageError, CancelledError, EXIT } from '../errors.js';

async function choose(title, choices, current) {
  const items = choices.map((ch) => ({ label: ch.label, hint: ch.hint, value: ch.value }));
  const idx = Math.max(0, items.findIndex((i) => i.value === current));
  const ordered = [items[idx], ...items.filter((_, i) => i !== idx)];
  const value = await pick(ordered, { title });
  if (value === null) throw new CancelledError();
  t.print(`${t.c.cyan('?')} ${t.c.bold(title)} ${t.c.green(items.find((i) => i.value === value).label)}`);
  return value;
}

// ------------------------------------------------------------------ configure
export const configure = {
  name: 'configure',
  summary: 'Interactive set-up of a MeshCentral server profile',
  usage: 'mesh configure [--profile name] [--url URL] [--user name] [--browser kind] [--shell kind]',
  options: {
    url: { type: 'string' }, user: { type: 'string' }, browser: { type: 'string' }, 'browser-path': { type: 'string' },
    shell: { type: 'string' }, default: { type: 'boolean' }, 'trust-fingerprint': { type: 'string' },
    insecure: { type: 'boolean' }, ca: { type: 'string' }, 'no-login': { type: 'boolean' },
  },
  async run(ctx, { opts }) {
    const config = loadConfig();
    const interactive = isInteractive();
    const existingName = opts.profile || config.defaultProfile || 'default';
    const name = validateProfileName(opts.profile || (interactive && !opts.url ? await ask('Profile name', { default: existingName }) : existingName));
    const prev = config.profiles[name] || { ...PROFILE_DEFAULTS };
    t.title('MeshctCLI configuration', `Profile "${name}"`);

    // Server URL + TLS
    const urlInput = opts.url || (interactive ? await ask('MeshCentral server URL', { default: prev.url ? hostLabel(prev.url) : undefined, validate: (v) => { try { normalizeServerUrl(v); return null; } catch (e) { return e.message; } } }) : null);
    if (!urlInput) throw new UsageError('Missing --url.');
    const { base, loginKey } = normalizeServerUrl(urlInput);
    const tls = { insecure: false, ca: opts.ca || prev.tls?.ca || null, fingerprint: null };
    if (base.startsWith('http:')) {
      t.status('warn', 'Plain http:// connection: credentials would travel unencrypted.');
      if (!interactive || !(await confirm('Continue with an unencrypted connection?'))) throw new CancelledError();
    } else if (opts.insecure) {
      tls.insecure = true;
    } else if (opts['trust-fingerprint']) {
      tls.fingerprint = normalizeFingerprint(opts['trust-fingerprint']);
    } else {
      let probe = null;
      try { probe = await withSpinner(`Checking TLS certificate of ${hostLabel(base)}…`, () => probeCertificate(base, { ca: tls.ca ? fs.readFileSync(tls.ca, 'utf8') : undefined })); } catch (err) {
        t.status('warn', `Cannot reach the server: ${err.message}`);
        if (interactive && !(await confirm('Save the profile anyway?', { default: false }))) throw new CancelledError();
      }
      if (probe) {
        const trusted = probe.authorized && !probe.hostError;
        if (trusted) {
          t.status('ok', `Certificate trusted (${probe.chain[0]?.subject} issued by ${probe.chain[0]?.issuer}).`);
        } else {
          const leaf = probe.chain[0];
          const fp = leafFingerprint(probe.chain);
          t.status('warn', `The server certificate is not trusted: ${probe.authorizationError || probe.hostError}`);
          t.keyValues([['Subject', leaf?.subject], ['Issuer', leaf?.issuer], ['Valid until', leaf?.validTo], ['SHA-256', fp]], { indent: 7 });
          if (prev.tls?.fingerprint && prev.tls.fingerprint === fp) {
            tls.fingerprint = fp;
            t.status('ok', 'Fingerprint matches the one already pinned for this profile.');
          } else if (interactive) {
            t.detail('Compare the fingerprint with the one shown by the server administrator before trusting it.', 7);
            if (await confirm('Trust this certificate by pinning its fingerprint?', { default: false })) tls.fingerprint = fp;
            else if (await confirm(`${t.c.red('Disable')} certificate verification for this profile (not recommended)?`, { default: false })) tls.insecure = true;
            else throw new CancelledError('Configuration cancelled: certificate not trusted.');
          } else {
            throw new MeshError('Server certificate is not trusted.', { exitCode: EXIT.NETWORK, hint: `Pass --trust-fingerprint ${fp} after verifying it, or --ca <file>.` });
          }
        }
      }
    }

    const user = opts.user || (interactive ? await ask('MeshCentral username', { default: prev.user || os.userInfo().username }) : prev.user);

    // Browser
    let browser = opts.browser || prev.browser || 'chrome';
    if (!BROWSERS.includes(browser)) throw new UsageError(`Unknown browser "${browser}". Use one of: ${BROWSERS.join(', ')}.`);
    if (interactive && !opts.browser) {
      const found = installedBrowsers();
      const choices = [
        ...found.map((b) => ({ label: b.kind, hint: `${b.kind === 'firefox' ? 'normal window' : 'app window'} · ${b.path}`, value: b.kind })),
        { label: 'default', hint: 'system default browser (normal tab)', value: 'default' },
      ];
      browser = await choose('Browser for "mesh web"', choices, found.some((b) => b.kind === prev.browser) ? prev.browser : found[0]?.kind || 'default');
    }

    // Remote shell
    let shell = opts.shell || prev.shell || 'auto';
    if (!['auto', 'powershell', 'cmd', 'sh'].includes(shell)) throw new UsageError('Shell must be auto, powershell, cmd or sh.');
    if (interactive && !opts.shell) {
      shell = await choose('Default remote shell', [
        { label: 'auto', hint: 'PowerShell on Windows, the default shell elsewhere', value: 'auto' },
        { label: 'powershell', hint: 'Windows only', value: 'powershell' },
        { label: 'cmd', hint: 'Windows Command Prompt', value: 'cmd' },
      ], shell);
    }

    if (interactive && !opts.url) {
      const color = await choose('Terminal colours', [
        { label: 'auto', hint: 'when the terminal supports them', value: 'auto' },
        { label: 'always', value: 'always' }, { label: 'never', value: 'never' },
      ], config.ui.color);
      config.ui.color = color;
    }

    config.profiles[name] = {
      ...prev, url: base, loginKey, user, browser, browserPath: opts['browser-path'] || prev.browserPath || null, shell, tls,
    };
    const makeDefault = opts.default || !config.defaultProfile || config.defaultProfile === name ||
      (interactive && await confirm(`Make "${name}" the default profile?`, { default: false }));
    if (makeDefault) config.defaultProfile = name;
    saveConfig(config);
    t.result('ok', `Profile "${name}" saved${makeDefault ? ' (default)' : ''}.`);

    if (!opts['no-login'] && interactive && await confirm('Log in now?', { default: true })) {
      ctx.options.profile = name;
      ctx._config = null; ctx._active = null;
      await login.run(ctx, { opts: { ...opts, user } });
    }
  },
};

// ------------------------------------------------------------------ login
async function interactiveConnect(profile, user, password) {
  let token;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return { client: await withSpinner(`Signing in to ${hostLabel(profile.url)}…`, () => MeshClient.connect({ profile, auth: { user, password, token } })), used2fa: Boolean(token) };
    } catch (err) {
      if (!(err instanceof AuthError) || err.reason !== 'tokenrequired') throw err;
      if (!isInteractive()) throw new AuthError('Two-factor authentication is required.', { reason: 'tokenrequired', hint: 'Run "mesh login" in an interactive terminal (or set MESHCLI_2FA).' });
      const via = [err.info.email2fa && 'email', err.info.sms2fa && 'sms', err.info.msg2fa && 'msg'].filter(Boolean);
      if (attempt > 0 && token && !err.info.email2fasent && !err.info.sms2fasent) t.status('fail', 'Invalid two-factor code.');
      else if (err.info.email2fasent || err.info.sms2fasent || err.info.msg2fasent) t.status('info', err.message);
      const code = await secret(`Two-factor code${via.length ? ` (or type ${via.join('/')} to receive one)` : ''}`);
      token = via.includes(code.trim().toLowerCase()) ? `**${code.trim().toLowerCase()}**` : code.trim();
    }
  }
  throw new AuthError('Too many failed two-factor attempts.', { reason: 'tokenrequired' });
}

export const login = {
  name: 'login',
  summary: 'Authenticate and store a revocable login token in the OS keyring',
  usage: 'mesh login [--user name] [--password-stdin] [--expire-days N] [--password-only] [--insecure-store]',
  options: {
    user: { type: 'string' }, 'password-stdin': { type: 'boolean' }, 'expire-days': { type: 'string' },
    'password-only': { type: 'boolean' }, 'insecure-store': { type: 'boolean' },
  },
  async run(ctx, { opts }) {
    const { profileName: name, profile } = ctx;
    const host = hostLabel(profile.url);
    const expireDays = opts['expire-days'] === undefined ? 365 : Number(opts['expire-days']);
    if (!Number.isFinite(expireDays) || expireDays < 0) throw new UsageError('--expire-days must be 0 (never) or a positive number.');
    const user = opts.user || profile.user || await ask('Username');
    const password = opts['password-stdin'] ? await secret('Password') : await secret(`Password for ${user}@${host}`);
    if (!password) throw new UsageError('Empty password.');

    t.title('MeshCentral', `Connecting to ${host}`);
    const { client, used2fa } = await interactiveConnect(profile, user, password);
    t.status('ok', `Authenticated as ${t.c.bold(client.userInfo.name || user)}${used2fa ? ' (two-factor)' : ''}.`);

    let backend = systemKeyring();
    if (!backend) {
      t.status('warn', 'No OS keyring available (macOS Keychain, Windows Credential Manager or Secret Service).');
      if (opts['insecure-store'] || (isInteractive() && await confirm('Store the credential in a file readable only by you (not encrypted)?', { default: false }))) {
        backend = BACKENDS.file;
      } else {
        client.close();
        t.result('warn', 'Logged in for this check only; nothing was stored.');
        t.detail('Use MESHCLI_USER / MESHCLI_PASSWORD for automation, or install libsecret (secret-tool).', 7);
        return;
      }
    }

    const previous = (() => { try { return loadStored(name, profile); } catch { return null; } })();
    let record = null;
    if (!opts['password-only']) {
      try {
        const token = await client.createLoginToken({ name: `MeshctCLI ${os.hostname()}`.slice(0, 100), expireMinutes: Math.round(expireDays * 1440) });
        record = { kind: 'token', user: token.user, secret: token.password, owner: user, tokenName: token.name, expire: token.expire || 0 };
        t.status('ok', `Login token "${token.name}" created${token.expire ? `, expires ${new Date(token.expire).toLocaleDateString()}` : ', no expiry'}.`);
      } catch (err) {
        t.status('warn', `Login tokens unavailable: ${err.message}`);
      }
    }
    if (!record) {
      if (!isInteractive() || !(await confirm(`Store your password in the ${backend.name} instead?`, { default: !backend.insecure }))) {
        client.close();
        t.result('warn', 'Nothing was stored; you will be asked for the password each time.');
        return;
      }
      record = { kind: 'password', user, secret: password, owner: user };
      if (used2fa) {
        const cookie = await client.twoFactorCookie();
        if (cookie) { record.twoFactorCookie = cookie; t.status('ok', 'Two-factor "remember this device" cookie stored.'); }
      }
    }

    // Store first; only then revoke the old token, so a storage failure never leaves the user with neither.
    try {
      saveStored(name, profile, record, backend);
    } catch (err) {
      t.status('warn', `${backend.name} could not store the credential: ${err.message}`);
      const alt = fallbackKeyring(backend);
      let stored = false;
      if (alt) {
        try { saveStored(name, profile, record, alt); backend = alt; stored = true; t.status('ok', `Stored with ${alt.name} instead.`); } catch (err2) { t.status('warn', `${alt.name}: ${err2.message}`); }
      }
      if (!stored) {
        if (opts['insecure-store'] || (isInteractive() && await confirm('Store the credential in a file readable only by you (not encrypted)?', { default: false }))) {
          saveStored(name, profile, record, BACKENDS.file);
          backend = BACKENDS.file;
        } else {
          client.close();
          throw new MeshError('Credentials could not be stored.', { hint: 'Use MESHCLI_USER / MESHCLI_PASSWORD for automation, or run "mesh login --insecure-store".' });
        }
      }
    }
    if (previous?.kind === 'token' && previous.user !== record.user) {
      try { await client.listLoginTokens({ remove: [previous.user] }); t.status('ok', 'Previous MeshctCLI login token revoked.'); } catch { /* non fatal */ }
    }
    client.close();
    if (record.kind === 'token') {
      await withSpinner('Verifying the stored token…', async () => {
        const check = await MeshClient.connect({ profile, auth: { user: record.user, password: record.secret } });
        check.close();
      });
    }
    const config = loadConfig();
    config.profiles[name] = { ...config.profiles[name], user, credentialStore: backend.id };
    saveConfig(config);
    t.result('ok', `Logged in. ${record.kind === 'token' ? 'Login token' : 'Password'} stored in ${backend.name}.`);
    if (record.kind === 'token') t.detail('Your password was not stored. Revoke the token any time in MeshCentral: My Account › Login Tokens.', 7);
  },
};

// ------------------------------------------------------------------ logout
export const logout = {
  name: 'logout',
  summary: 'Remove stored credentials (and optionally revoke the login token)',
  usage: 'mesh logout [--revoke]',
  options: { revoke: { type: 'boolean' } },
  async run(ctx, { opts }) {
    const { profileName: name, profile } = ctx;
    const stored = (() => { try { return loadStored(name, profile); } catch { return null; } })();
    if (!stored) { t.result('skip', `No stored credentials for profile "${name}".`); return; }
    if (stored.kind === 'token' && opts.revoke) {
      const user = stored.owner || profile.user || await ask('Username');
      const { client } = await interactiveConnect(profile, user, await secret(`Password for ${user} (needed to revoke the token)`));
      await client.listLoginTokens({ remove: [stored.user] });
      client.close();
      t.status('ok', 'Login token revoked on the server.');
    }
    deleteStored(name, profile);
    clearDeviceCache(name);
    t.result('ok', `Credentials for "${name}" removed from ${backendFor(profile)?.name || 'storage'}.`);
    if (stored.kind === 'token' && !opts.revoke) t.detail('The token stays valid on the server until revoked (My Account › Login Tokens, or "mesh logout --revoke").', 7);
  },
};

// ------------------------------------------------------------------ status
export const status = {
  name: 'status',
  summary: 'Show the active profile, credentials and connection status',
  usage: 'mesh status [--offline] [--json]',
  options: { offline: { type: 'boolean' } },
  async run(ctx, { opts }) {
    const { profileName: name, profile } = ctx;
    let creds = null; let credError = null;
    try { creds = resolveCredentials(name, profile); } catch (err) { credError = err.message; }
    const cache = readDeviceCache(name);
    const info = {
      profile: name, server: profile.url, user: profile.user,
      tls: profile.tls.insecure ? 'verification disabled' : profile.tls.fingerprint ? `pinned ${profile.tls.fingerprint.slice(0, 23)}…` : 'CA verified',
      credentials: creds ? creds.source : credError || 'none',
      tokenExpires: creds?.record?.expire ? new Date(creds.record.expire).toISOString() : null,
      cachedDevices: cache?.devices.length ?? 0, cacheAge: cache ? formatRelativeTime(cache.time) : null, connected: null,
    };
    if (!opts.offline && creds) {
      try {
        const client = await ctx.client();
        info.connected = true; info.serverUser = client.userInfo.name; info.serverVersion = client.serverInfo?.version || null;
      } catch (err) { info.connected = false; info.error = err.message; }
    }
    if (opts.json) { t.print(JSON.stringify(info, null, 2)); return; }
    t.title('MeshCentral', `Profile "${name}"`);
    t.keyValues([
      ['Server', hostLabel(profile.url)], ['User', profile.user], ['TLS', info.tls],
      ['Credentials', creds ? `${creds.source}${info.tokenExpires ? ` (expires ${info.tokenExpires.slice(0, 10)})` : ''}` : t.c.yellow(info.credentials)],
      ['Device cache', cache ? `${info.cachedDevices} devices, updated ${info.cacheAge}` : 'empty'],
    ]);
    if (info.connected === true) t.result('ok', `Connected to ${hostLabel(profile.url)} as ${info.serverUser}.`);
    else if (info.connected === false) { t.result('fail', `Connection failed: ${info.error}`); process.exitCode = EXIT.NETWORK; }
    else if (!creds) t.result('warn', 'Not logged in. Run "mesh login".');
  },
};

// ------------------------------------------------------------------ profile
export const profile = {
  name: 'profile',
  aliases: ['profiles'],
  summary: 'List, switch or remove server profiles',
  usage: 'mesh profile [list | use <name> | remove <name>]',
  positionals: [{ name: 'action' }, { name: 'target' }],
  async run(ctx, { args, opts }) {
    const config = loadConfig();
    const action = args.action || 'list';
    if (action === 'list') {
      const names = Object.keys(config.profiles);
      if (opts.json) { t.print(JSON.stringify(names.map((n) => ({ name: n, default: n === config.defaultProfile, url: config.profiles[n].url, user: config.profiles[n].user })), null, 2)); return; }
      t.title('Profiles');
      if (!names.length) { t.result('warn', 'No profiles. Run "mesh configure".'); return; }
      for (const n of names) t.item(n === config.defaultProfile ? 'ok' : 'skip', t.c.bold(n), `${config.profiles[n].user || '?'}@${hostLabel(config.profiles[n].url)}${n === config.defaultProfile ? ' · default' : ''}`);
      return;
    }
    if (!args.target) throw new UsageError(`Usage: mesh profile ${action} <name>`);
    resolveProfile(config, args.target); // validates existence
    if (action === 'use') { config.defaultProfile = args.target; saveConfig(config); t.result('ok', `Default profile is now "${args.target}".`); return; }
    if (action === 'remove') {
      if (!opts.yes && !(isInteractive() && await confirm(`Remove profile "${args.target}" and its stored credentials?`))) throw new CancelledError();
      try { deleteStored(args.target, config.profiles[args.target]); } catch { /* ignore */ }
      clearDeviceCache(args.target);
      delete config.profiles[args.target];
      if (config.defaultProfile === args.target) config.defaultProfile = Object.keys(config.profiles)[0] || null;
      saveConfig(config);
      t.result('ok', `Profile "${args.target}" removed.`);
      return;
    }
    throw new UsageError(`Unknown action "${action}". Use list, use or remove.`);
  },
};
