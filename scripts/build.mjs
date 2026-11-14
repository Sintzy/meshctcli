#!/usr/bin/env node
// Build a standalone MeshCLI executable for the platform this script runs on.
//
//   npm run build          ->  dist/mesh-<os>-<arch>[.exe]  (+ dist/mesh.cjs bundle)
//
// Steps: sync src/version.js -> esbuild bundle (one CommonJS file, `ws` included) -> Node
// "single executable application" blob -> inject into a copy of the node binary (postject).
// Cross-compiling is not possible with this method, so CI builds each platform (see
// .github/workflows/release.yml).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const platform = { darwin: 'darwin', linux: 'linux', win32: 'win' }[process.platform];
if (!platform) throw new Error(`Unsupported platform ${process.platform}`);
const exeName = `mesh-${platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const out = path.join(dist, exeName);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 1. version module
fs.writeFileSync(path.join(root, 'src', 'version.js'), `// Generated from package.json by scripts/build.mjs (kept in sync by a unit test).\nexport const VERSION = '${pkg.version}';\n`);

// 2. bundle
await build({
  entryPoints: [path.join(root, 'bin', 'mesh.js')],
  outfile: path.join(dist, 'mesh.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['bufferutil', 'utf-8-validate'], // optional native accelerators of `ws`
  banner: { js: 'process.env.MESHCLI_BUNDLED = "1";' },
  logLevel: 'warning',
});
let bundle = fs.readFileSync(path.join(dist, 'mesh.cjs'), 'utf8').replace(/^#!.*\n/, '');
fs.writeFileSync(path.join(dist, 'mesh.cjs'), bundle);

// 3. SEA blob
const seaConfig = path.join(dist, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({ main: path.join(dist, 'mesh.cjs'), output: path.join(dist, 'sea.blob'), disableExperimentalSEAWarning: true }));
run(process.execPath, ['--experimental-sea-config', seaConfig]);

// 4. inject into a copy of node
fs.copyFileSync(process.execPath, out);
fs.chmodSync(out, 0o755);
if (process.platform === 'darwin') spawnSync('codesign', ['--remove-signature', out], { stdio: 'inherit' });
const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
const injectArgs = [postject, out, 'NODE_SEA_BLOB', path.join(dist, 'sea.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') injectArgs.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, injectArgs);
if (process.platform === 'darwin') run('codesign', ['--sign', '-', out]);

// 5. checksum
const sum = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
fs.writeFileSync(`${out}.sha256`, `${sum}  ${exeName}\n`);
fs.rmSync(path.join(dist, 'sea.blob'));
fs.rmSync(seaConfig);

console.log(`\nBuilt ${path.relative(root, out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB), sha256 ${sum.slice(0, 16)}…`);
