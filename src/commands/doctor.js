// mesh doctor: local and remote diagnostics, Symfony "doctor:check" style.
import fs from 'node:fs';
import * as t from '../ui/term.js';
import { loadConfig, resolveProfile } from '../config/config.js';
import { paths } from '../config/paths.js';
import { systemKeyring } from '../auth/keyring.js';
import { resolveCredentials, backendFor } from '../auth/credentials.js';
import { findBrowser } from '../browser/browser.js';
import { detectShell, isInstalled, legacyIntegration } from '../completion/install.js';
import { readDeviceCache } from '../mesh/cache.js';
import { probeCertificate, normalizeFingerprint, leafFingerprint } from '../mesh/tls.js';
import { hostLabel } from '../mesh/url.js';
import { FileSession } from '../session/files.js';
import { formatRelativeTime, sanitize } from '../ui/format.js';
import { EXIT } from '../errors.js';

export const doctor = {
  name: 'doctor',
  aliases: ['check'],
  summary: 'Diagnose configuration, credentials, connectivity (and a device, if given)',
  usage: 'mesh doctor [device]',
  positionals: [{ name: 'device' }],
  async run(ctx, { args }) {
    const results = [];
    const check = (kind, text, meta) => { results.push(kind); t.item(kind, text, meta); };

    t.title('MeshCLI doctor', `Node.js ${process.version} on ${process.platform}/${process.arch}`);
    t.section('Local');
    const [major, minor] = process.versions.node.split('.').map(Number);
    check(major > 18 || (major === 18 && minor >= 17) ? 'ok' : 'fail', `Node.js ${process.version}`, major >= 18 ? undefined : 'requires 18.17 or newer');

    let config;
    try { config = loadConfig(); check('ok', 'Configuration readable', paths.configFile); } catch (err) { check('fail', 'Configuration unreadable', err.message); }
    let resolved = null;
    try { resolved = config && resolveProfile(config, ctx.options.profile); } catch (err) { check('fail', err.message); }
    if (!resolved?.profile?.url) {
      check('fail', 'No server profile configured', 'run "mesh configure"');
      return finish(results);
    }
    const { name, profile } = resolved;
    check('ok', `Profile "${name}"`, `${profile.user || '?'}@${hostLabel(profile.url)}`);

    const keyring = systemKeyring();
    check(keyring ? 'ok' : 'warn', keyring ? `Keyring: ${keyring.name}` : 'No OS keyring available', keyring ? undefined : 'login tokens cannot be stored securely');
    let creds = null;
    try {
      creds = resolveCredentials(name, profile);
      const store = backendFor(profile);
      if (creds) check(store?.insecure && creds.source !== 'environment' ? 'warn' : 'ok', `Credentials: ${creds.source}`, creds.record?.expire ? `expires ${new Date(creds.record.expire).toLocaleDateString()}` : store?.insecure ? 'stored in a plain file' : undefined);
      else check('warn', 'Not logged in', 'run "mesh login"');
    } catch (err) { check('fail', 'Credentials', err.message); }

    const browser = profile.browser === 'default' ? null : findBrowser(profile.browser, { browserPath: profile.browserPath });
    if (profile.browser === 'default') check('skip', 'Browser: system default', 'no app window');
    else check(browser ? 'ok' : 'warn', browser ? `Browser: ${browser.kind}` : `Browser "${profile.browser}" not found`, browser ? browser.path : 'mesh web will use the default browser');

    const shell = detectShell();
    check(isInstalled(shell) ? 'ok' : 'skip', `Tab completion (${shell})`, isInstalled(shell) ? undefined : 'run "mesh completion install"');
    const legacy = legacyIntegration();
    if (legacy) check('warn', 'Old prototype integration found', `${legacy} sources ~/.config/mesh-cli/mesh.zsh, which defines a "mesh" function hiding this CLI; run "mesh completion install" to replace it`);
    const cache = readDeviceCache(name);
    check(cache ? 'ok' : 'skip', cache ? `Device cache: ${cache.devices.length} devices` : 'Device cache empty', cache ? `updated ${formatRelativeTime(cache.time)}` : 'filled by "mesh list"');

    t.section('Server');
    let probe = null;
    try {
      probe = await probeCertificate(profile.url, { ca: profile.tls.ca ? fs.readFileSync(profile.tls.ca, 'utf8') : undefined });
      check('ok', `Reachable: ${hostLabel(profile.url)}`);
    } catch (err) { check('fail', `Server unreachable: ${err.message}`); }
    if (probe?.secure) {
      if (profile.tls.insecure) check('warn', 'TLS verification disabled for this profile');
      else if (profile.tls.fingerprint) {
        const fp = leafFingerprint(probe.chain);
        check(fp === normalizeFingerprint(profile.tls.fingerprint) ? 'ok' : 'fail', fp === normalizeFingerprint(profile.tls.fingerprint) ? 'TLS certificate matches pinned fingerprint' : 'TLS certificate changed since it was pinned', fp === normalizeFingerprint(profile.tls.fingerprint) ? undefined : 're-run "mesh configure" if this is expected');
      } else check(probe.authorized && !probe.hostError ? 'ok' : 'fail', probe.authorized && !probe.hostError ? 'TLS certificate trusted' : `TLS certificate not trusted (${probe.authorizationError || probe.hostError})`, probe.chain[0] ? `issued by ${probe.chain[0].issuer}, valid until ${probe.chain[0].validTo}` : undefined);
    } else if (probe) check('warn', 'Plain HTTP connection (no TLS)');

    let client = null;
    if (creds && results.at(-1) !== 'fail') {
      try {
        client = await ctx.client();
        check('ok', `Authenticated as ${sanitize(client.userInfo.name)}`, client.serverInfo?.name ? `server ${sanitize(client.serverInfo.name)}` : undefined);
      } catch (err) { check('fail', `Authentication failed: ${err.message}`); }
    } else check('skip', 'Authentication not tested', creds ? 'server unreachable' : 'not logged in');

    if (client) {
      try {
        const devices = await ctx.devices({ refresh: true });
        const online = devices.filter((d) => d.online).length;
        check(devices.length ? 'ok' : 'warn', `${devices.length} devices visible`, `${online} online, ${devices.length - online} offline`);
      } catch (err) { check('fail', `Device list failed: ${err.message}`); }
      const cookie = await client.loginCookie().catch(() => null);
      check(cookie ? 'ok' : 'skip', cookie ? 'Web sign-in cookie available' : 'Web sign-in cookie not available', cookie ? '"mesh web" opens already signed in' : 'enable settings.allowLoginToken on the server for automatic sign-in in "mesh web"');
    }

    if (client && args.device) {
      t.section(`Device "${args.device}"`);
      try {
        const device = await ctx.device(args.device);
        check(device.online ? 'ok' : 'fail', device.online ? `${sanitize(device.name)} agent connected` : `${sanitize(device.name)} is offline`, device.osDesc ? sanitize(device.osDesc) : undefined);
        if (device.online) {
          for (const cap of ['desktop', 'terminal', 'files']) {
            const has = device.caps & { desktop: 1, terminal: 2, files: 4 }[cap];
            check(has ? 'ok' : 'skip', `${cap[0].toUpperCase()}${cap.slice(1)} capability`, has ? undefined : 'not reported by the agent');
          }
          const started = Date.now();
          try {
            const session = await FileSession.open(client, device);
            const entries = await session.ls(device.os === 'windows' ? '' : '/');
            session.close();
            check('ok', 'Relay tunnel works', `files session, ${entries ? entries.length : 0} entries, ${Date.now() - started} ms`);
          } catch (err) { check('fail', `Relay tunnel failed: ${err.message}`); }
          if (device.os === 'windows') check('skip', 'Native RDP not tested', 'use "mesh rdp" to try it');
          else check('skip', 'Native RDP not applicable', 'not a Windows device');
        }
      } catch (err) { check('fail', err.message); }
    }
    return finish(results);
  },
};

function finish(results) {
  const failures = results.filter((r) => r === 'fail').length;
  const warnings = results.filter((r) => r === 'warn').length;
  if (failures) { t.result('fail', `${failures} problem${failures === 1 ? '' : 's'} detected.`); process.exitCode = EXIT.ERROR; }
  else if (warnings) t.result('warn', `No problems, ${warnings} warning${warnings === 1 ? '' : 's'}.`);
  else t.result('ok', 'Everything looks good.');
}
