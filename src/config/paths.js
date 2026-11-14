// Platform-specific locations for configuration, cache and integration scripts.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const APP_DIR_NAME = 'meshcli';

/**
 * Config directory:
 *   MESHCLI_CONFIG_DIR (override, used by tests)
 *   Windows: %APPDATA%\meshcli
 *   others:  $XDG_CONFIG_HOME/meshcli or ~/.config/meshcli
 */
export function configDir(env = process.env, platform = process.platform) {
  if (env.MESHCLI_CONFIG_DIR) return path.resolve(env.MESHCLI_CONFIG_DIR);
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_DIR_NAME);
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_DIR_NAME);
}

export const paths = {
  get config() { return configDir(); },
  get configFile() { return path.join(configDir(), 'config.json'); },
  get cacheDir() { return path.join(configDir(), 'cache'); },
  get certsDir() { return path.join(configDir(), 'certs'); },
  get completionDir() { return path.join(configDir(), 'completion'); },
  get browserProfile() { return path.join(configDir(), 'browser-profile'); },
  get insecureCredentials() { return path.join(configDir(), 'credentials.json'); },
};

/** Create a directory readable only by the current user. */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') { try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ } }
}

/** Atomically write a file readable only by the current user. */
export function writePrivateFile(file, content) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch { /* best effort */ } }
}
