// Per-profile device cache: used for Tab completion (no network on <Tab>) and for fast lookups.
import fs from 'node:fs';
import path from 'node:path';
import { paths, writePrivateFile } from '../config/paths.js';

const cacheFile = (profileName) => path.join(paths.cacheDir, `devices-${profileName}.json`);

export function writeDeviceCache(profileName, server, devices) {
  const slim = devices.map(({ id, name, group, os, online }) => ({ id, name, group, os, online }));
  try {
    writePrivateFile(cacheFile(profileName), JSON.stringify({ server, time: Date.now(), devices: slim }));
  } catch { /* the cache is an optimisation only */ }
}

export function readDeviceCache(profileName) {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile(profileName), 'utf8'));
    return Array.isArray(data.devices) ? data : null;
  } catch { return null; }
}

export function clearDeviceCache(profileName) {
  try { fs.unlinkSync(cacheFile(profileName)); return true; } catch { return false; }
}

/** Names suitable for shell completion: one per line, control characters removed. */
export function completionNames(profileName) {
  const data = readDeviceCache(profileName);
  if (!data) return [];
  // eslint-disable-next-line no-control-regex
  return [...new Set(data.devices.map((d) => String(d.name).replace(/[\x00-\x1f\x7f]/g, ' ').trim()).filter(Boolean))];
}
