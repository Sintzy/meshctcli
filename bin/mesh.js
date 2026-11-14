#!/usr/bin/env node
// MeshCLI executable (installed as "mesh" and "meshcli").
import { main } from '../src/cli/main.js';

// Always give the cursor back (the picker hides it), even after an unexpected exit.
process.on('exit', () => { if (process.stderr.isTTY) process.stderr.write('\x1b[?25h'); });

// Let pending writes flush, then exit with the command's code (open sockets must not keep us alive).
main(process.argv.slice(2)).then((code) => process.stdout.write('', () => process.exit(code)));
