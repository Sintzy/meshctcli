#!/usr/bin/env node
// Concatenate the source into one plain-text file (MeshCLI-source.txt) for easy copying/review.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel);
    else if (/\.(m?js|json|sh|ps1|md)$/.test(entry.name)) files.push(rel);
  }
};
['package.json', 'README.md'].forEach((f) => files.push(f));
['bin', 'src', 'scripts', 'test'].forEach(walk);

const out = [`MeshCLI source bundle — generated ${new Date().toISOString()}`, `Files: ${files.length}`, '', ...files.map((f) => `  ${f}`), ''];
for (const f of files) {
  out.push('='.repeat(100), `FILE: ${f.split(path.sep).join('/')}`, '='.repeat(100), fs.readFileSync(path.join(root, f), 'utf8'), '');
}
const target = path.join(root, 'MeshCLI-source.txt');
fs.writeFileSync(target, out.join('\n'));
console.log(`Wrote ${target} (${files.length} files)`);
