// Persistent configuration with multiple server profiles.
import fs from 'node:fs';
import { paths, writePrivateFile } from './paths.js';
import { MeshError, UsageError } from '../errors.js';

export const CONFIG_VERSION = 1;

export const PROFILE_DEFAULTS = Object.freeze({
  url: null,            // canonical https base URL, e.g. https://mesh.example.com:443/
  loginKey: null,       // optional server URL key (?key=...)
  user: null,           // MeshCentral username used by "mesh login"
  browser: 'chrome',    // chrome | edge | chromium | brave | default | custom
  browserPath: null,    // explicit executable when browser = custom (or to override detection)
  shell: 'auto',        // auto | powershell | cmd | bash (remote shell default)
  confirmDestructive: true,
  tls: { insecure: false, ca: null }, // ca = path to a PEM file trusted for this server
});

export const UI_DEFAULTS = Object.freeze({ color: 'auto', unicode: 'auto' });

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateProfileName(name) {
  if (!PROFILE_NAME_RE.test(String(name || ''))) {
    throw new UsageError(`Invalid profile name "${name}".`, { hint: 'Use letters, digits, ".", "_" or "-" (max 64 characters).' });
  }
  return name;
}

export function emptyConfig() {
  return { version: CONFIG_VERSION, defaultProfile: null, profiles: {}, ui: { ...UI_DEFAULTS } };
}

export function loadConfig(file = paths.configFile) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return emptyConfig();
    throw new MeshError(`Cannot read configuration file ${file}: ${err.message}`);
  }
  let data;
  try { data = JSON.parse(text); } catch (err) {
    throw new MeshError(`Configuration file is not valid JSON: ${file}`, { hint: 'Fix or delete the file and run "mesh configure".', cause: err });
  }
  const config = { ...emptyConfig(), ...data };
  config.ui = { ...UI_DEFAULTS, ...(data.ui || {}) };
  config.profiles = {};
  for (const [name, p] of Object.entries(data.profiles || {})) {
    config.profiles[name] = { ...PROFILE_DEFAULTS, ...p, tls: { ...PROFILE_DEFAULTS.tls, ...(p?.tls || {}) } };
  }
  return config;
}

export function saveConfig(config, file = paths.configFile) {
  writePrivateFile(file, `${JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2)}\n`);
}

/**
 * Resolve the active profile: --profile flag > MESHCLI_PROFILE > defaultProfile > the only profile.
 * @returns {{ name: string, profile: object } | null}
 */
export function resolveProfile(config, requested, env = process.env) {
  const name = requested || env.MESHCLI_PROFILE || config.defaultProfile ||
    (Object.keys(config.profiles).length === 1 ? Object.keys(config.profiles)[0] : null);
  if (!name) return null;
  const profile = config.profiles[name];
  if (!profile) {
    const known = Object.keys(config.profiles);
    throw new UsageError(`Profile "${name}" does not exist.`, {
      hint: known.length ? `Known profiles: ${known.join(', ')}. Create one with "mesh configure --profile ${name}".` : 'Run "mesh configure" to create one.',
    });
  }
  return { name, profile };
}

/** Like resolveProfile, but fails with a helpful message when nothing is configured. */
export function requireProfile(config, requested) {
  const resolved = resolveProfile(config, requested);
  if (!resolved || !resolved.profile.url) {
    throw new UsageError('MeshctCLI is not configured yet.', { hint: 'Run "mesh configure" to set up a MeshCentral server.' });
  }
  return resolved;
}
