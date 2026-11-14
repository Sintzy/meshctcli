// Per-invocation context shared by all commands: config, profile, connection, devices.
import { loadConfig, requireProfile } from './config/config.js';
import { resolveCredentials } from './auth/credentials.js';
import { MeshClient } from './mesh/client.js';
import { normalizeDevices, matchDevices, deviceNotFound, ambiguous, OS_LABEL } from './mesh/devices.js';
import { writeDeviceCache } from './mesh/cache.js';
import { hostLabel } from './mesh/url.js';
import { AuthError, MeshError, CancelledError, EXIT } from './errors.js';
import { isInteractive, ask, secret } from './ui/prompt.js';
import { pick } from './ui/picker.js';
import { withSpinner } from './ui/progress.js';

export class Context {
  constructor({ options = {} } = {}) {
    this.options = options;
    this._config = null;
    this._client = null;
    this._devices = null;
  }

  get config() { return (this._config ??= loadConfig()); }

  get active() { return (this._active ??= requireProfile(this.config, this.options.profile)); }
  get profileName() { return this.active.name; }
  get profile() { return this.active.profile; }
  get host() { return hostLabel(this.profile.url); }

  /** Connected, authenticated control channel (memoised). */
  async client() {
    if (this._client && !this._client.closed) return this._client;
    let creds = resolveCredentials(this.profileName, this.profile);
    if (!creds) {
      if (!isInteractive()) {
        throw new AuthError(`Not logged in to ${this.host}.`, { reason: 'nocredentials', hint: 'Run "mesh login", or set MESHCLI_USER and MESHCLI_PASSWORD.' });
      }
      const user = this.profile.user || await ask('Username');
      creds = { source: 'prompt', user, password: await secret(`Password for ${user}@${this.host}`) };
    }
    this._client = await this.#connectWith2fa(creds);
    return this._client;
  }

  async #connectWith2fa(creds) {
    let auth = { user: creds.user, password: creds.password, token: creds.token };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await withSpinner(`Connecting to ${this.host}${'…'}`, () => MeshClient.connect({ profile: this.profile, auth, timeout: this.options.timeout }));
      } catch (err) {
        if (err instanceof AuthError && err.reason === 'tokenrequired' && isInteractive()) {
          auth = { ...auth, token: await secret('Two-factor code') };
          continue;
        }
        if (err instanceof AuthError && creds.source === 'login token' && err.reason === 'invalid') {
          err.message = 'The stored login token was rejected (revoked or expired?).';
          err.hint = 'Run "mesh login" to sign in again.';
        }
        throw err;
      }
    }
    throw new AuthError('Too many invalid two-factor codes.', { reason: 'tokenrequired' });
  }

  async devices({ refresh = false } = {}) {
    if (this._devices && !refresh) return this._devices;
    const client = await this.client();
    const raw = await client.listDevices();
    this._devices = normalizeDevices(raw);
    writeDeviceCache(this.profileName, this.profile.url, this._devices);
    return this._devices;
  }

  /**
   * Resolve one device from a user query. Uses the interactive picker when the query is empty
   * or ambiguous and a terminal is available.
   */
  async device(query, { requireOnline = false, title } = {}) {
    const devices = await this.devices();
    if (!devices.length) throw new MeshError('No devices are visible to this account.', { exitCode: EXIT.NOT_FOUND });
    const { matches } = matchDevices(devices, query);
    let device;
    if (query && matches.length === 1) device = matches[0];
    else if (query && !matches.length) throw deviceNotFound(query, devices);
    else if (!isInteractive()) throw query ? ambiguous(query, matches) : new MeshError('No device given.', { exitCode: EXIT.USAGE, hint: 'Pass a device name, e.g. "mesh shell Lenovo3".' });
    else {
      device = await pick(matches.map(toPickerItem), { title: title || (query ? `Several devices match "${query}"` : 'Select a device') });
      if (!device) throw new CancelledError();
    }
    if (requireOnline && !device.online) {
      throw new MeshError(`${device.name} is offline (agent not connected).`, { exitCode: EXIT.OFFLINE, hint: device.os === 'windows' ? 'Try "mesh wake" if Wake-on-LAN is configured.' : undefined });
    }
    return device;
  }

  close() { if (this._client) this._client.close(); }
}

export function toPickerItem(d) {
  return {
    label: d.name,
    hint: [OS_LABEL[d.os], d.online ? 'online' : 'offline', d.group].filter(Boolean).join(' · '),
    badge: d.online ? 'ok' : 'skip',
    search: `${d.name} ${d.group || ''} ${d.host || ''}`,
    value: d,
  };
}
