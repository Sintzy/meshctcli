#!/usr/bin/env node
// Build the single-file distribution of MeshctCLI: dist/mesh.cjs (+ dist/mesh.cjs.sha256).
//
//   npm run build
//
// The file bundles the code and its only dependency (`ws`). It runs on any machine that has
// Node.js 18.17+ installed, on every OS; Node.js itself is NOT bundled or downloaded.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// version module (kept in sync with package.json)
fs.writeFileSync(path.join(root, 'src', 'version.js'), `// Generated from package.json by scripts/build.mjs (kept in sync by a unit test).\nexport const VERSION = '${pkg.version}';\n`);

const guard = 'var __v=process.versions.node.split(".").map(Number);if(__v[0]<18||(__v[0]===18&&__v[1]<17)){console.error(" FAIL   MeshctCLI needs Node.js 18.17 or newer (found "+process.version+"). Get it at https://nodejs.org/");process.exit(1)}';

const out = path.join(dist, 'mesh.cjs');
await build({
  entryPoints: [path.join(root, 'bin', 'mesh.js')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['bufferutil', 'utf-8-validate'], // optional native accelerators of `ws`
  banner: { js: `${guard}\nprocess.env.MESHCLI_BUNDLED = "1";` },
  logLevel: 'warning',
});
fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replace(/^#!.*\n/, ''));

const sum = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
fs.writeFileSync(`${out}.sha256`, `${sum}  mesh.cjs\n`);
console.log(`Built ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB), sha256 ${sum.slice(0, 16)}…`);
