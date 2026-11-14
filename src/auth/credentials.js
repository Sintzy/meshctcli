// Credential resolution and persistence.
//
// Preferred: "mesh login" authenticates once with password (+2FA), then asks the server for a
// MeshCentral *login token* (an official, revocable, optionally expiring username/password pair).
// Only the token is stored, in the OS keyring. The real password is never written anywhere.
// Fallback (server refuses tokens): the password itself, again only in the OS keyring.
import { systemKeyring, backendById } from './keyring.js';
import { hostLabel } from '../mesh/url.js';
import { AuthError, MeshError } from '../errors.js';

export const keyringAccount = (profileName, profile) => `${profileName}@${hostLabel(profile.url).replace(/[^A-Za-z0-9@._:+-]/g, '_')}`;

/** Backend used for a profile: the one recorded at login time, else the system keyring. */
export function backendFor(profile) {
  if (profile.credentialStore) {
    const b = backendById(profile.credentialStore);
    if (b && b.available()) return b;
  }
  return systemKeyring();
}

/**
 * Stored credential record:
 * { v: 1, kind: 'token'|'password', user, secret, owner, tokenName?, expire?, twoFactorCookie?, created }
 */
export function loadStored(profileName, profile) {
  const backend = backendFor(profile);
  if (!backend) return null;
  const raw = backend.get(keyringAccount(profileName, profile));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    return rec && rec.user && rec.secret ? rec : null;
  } catch { return null; }
}

export function saveStored(profileName, profile, record, backend) {
  backend.set(keyringAccount(profileName, profile), JSON.stringify({ v: 1, created: Date.now(), ...record }));
}

export function deleteStored(profileName, profile) {
  const backend = backendFor(profile);
  return backend ? backend.delete(keyringAccount(profileName, profile)) : false;
}

/** Credentials from the environment (CI / automation). MESHCTRL_* kept for compatibility with meshctrl. */
export function envCredentials(profile, env = process.env) {
  const password = env.MESHCLI_PASSWORD ?? env.MESHCTRL_LOGINPASS;
  if (password === undefined) return null;
  const user = env.MESHCLI_USER || env.MESHCTRL_LOGINUSER || profile.user;
  if (!user) throw new AuthError('MESHCLI_PASSWORD is set but no user is known.', { reason: 'nocredentials', hint: 'Set MESHCLI_USER or configure a user with "mesh configure".' });
  return { source: 'environment', user, password, token: env.MESHCLI_2FA || env.MESHCTRL_TOKEN || undefined };
}

/** Credentials to use for a connection, without prompting. */
export function resolveCredentials(profileName, profile) {
  const fromEnv = envCredentials(profile);
  if (fromEnv) return fromEnv;
  let stored = null;
  try { stored = loadStored(profileName, profile); } catch (err) {
    throw new MeshError(`Cannot read stored credentials: ${err.message}`, { hint: 'Run "mesh doctor" for details, or "mesh login" again.' });
  }
  if (stored) {
    if (stored.expire && stored.expire < Date.now()) {
      throw new AuthError('The stored login token has expired.', { reason: 'expired', hint: 'Run "mesh login" to create a new one.' });
    }
    return {
      source: stored.kind === 'token' ? 'login token' : 'stored password',
      kind: stored.kind,
      user: stored.user,
      password: stored.secret,
      token: stored.twoFactorCookie ? `cookie=${stored.twoFactorCookie}` : undefined,
      owner: stored.owner,
      record: stored,
    };
  }
  return null;
}
