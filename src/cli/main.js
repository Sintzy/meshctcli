// Entry point: global flags, command dispatch, error handling and exit codes.
import { VERSION } from '../version.js';
import { splitCommand, parseCommandArgs, scanGlobalFlags } from './args.js';
import { Context } from '../context.js';
import * as t from '../ui/term.js';
import { loadConfig } from '../config/config.js';
import { MeshError, UsageError, EXIT } from '../errors.js';
import { complete } from '../completion/complete.js';
import { completionNames } from '../mesh/cache.js';
import { SCRIPTS } from '../completion/scripts.js';
import { install, uninstall, detectShell } from '../completion/install.js';
import { configure, login, logout, status, profile } from '../commands/account.js';
import { list, refresh, groups, info } from '../commands/devices.js';
import { shell, ps, cmd, run, web, tunnel, rdp, relay } from '../commands/remote.js';
import { upload, download, files } from '../commands/files.js';
import { toast, message, openUrl, restart, shutdown, sleep, wake } from '../commands/actions.js';
import { doctor } from '../commands/doctor.js';
import { installCmd, uninstallCmd } from '../commands/selfinstall.js';

export { VERSION };

const completion = {
  name: 'completion',
  summary: 'Print or install Tab completion (zsh, bash, fish, powershell)',
  usage: 'mesh completion [install|uninstall] [zsh|bash|fish|powershell]   |   mesh completion <shell>',
  positionals: [{ name: 'action' }, { name: 'shell' }],
  async run(_ctx, { args }) {
    const action = args.action || 'install';
    if (SCRIPTS[action]) { process.stdout.write(SCRIPTS[action]()); return; }
    if (action !== 'install' && action !== 'uninstall') throw new UsageError(`Unknown action "${action}".`, { hint: 'Use install, uninstall or a shell name.' });
    const shellName = args.shell || detectShell();
    const r = action === 'install' ? install(shellName) : uninstall(shellName);
    for (const a of r.actions) t.status('ok', a);
    if (r.manual) t.print(`\n  ${r.manual}\n`);
    t.result('ok', action === 'install' ? `Completion installed for ${r.shell}.` : `Completion removed for ${r.shell}.`);
    if (r.reload) t.detail(r.reload, 7);
  },
};

const version = { name: 'version', summary: 'Show the MeshctCLI version', usage: 'mesh version', run: () => t.print(`MeshctCLI ${VERSION} (Node.js ${process.version})`) };

const help = {
  name: 'help',
  summary: 'Show help for all commands or one command',
  usage: 'mesh help [command]',
  positionals: [{ name: 'command' }],
  run: (_ctx, { args }) => printHelp(args.command),
};

/** Ordered, grouped command table. */
export const GROUPS = [
  ['Setup', [configure, login, logout, status, profile, doctor, completion, installCmd, uninstallCmd]],
  ['Devices', [list, info, groups, refresh]],
  ['Sessions', [shell, ps, cmd, run, web, rdp, tunnel, relay]],
  ['Files', [files, upload, download]],
  ['Actions', [toast, message, openUrl, restart, shutdown, sleep, wake]],
  ['Other', [help, version]],
];

export const COMMANDS = new Map();
for (const [, cmds] of GROUPS) for (const c of cmds) { COMMANDS.set(c.name, c); for (const a of c.aliases || []) COMMANDS.set(a, c); }

export function printHelp(name) {
  if (name) {
    const c = COMMANDS.get(name);
    if (!c) throw new UsageError(`Unknown command "${name}".`);
    t.title(`mesh ${c.name}`, c.summary);
    t.section('Usage');
    t.print(`  ${c.usage}`);
    if (c.aliases?.length) { t.section('Aliases'); t.print(`  ${c.aliases.join(', ')}`); }
    t.section('Global options');
    t.print('  -p, --profile <name>   use another server profile');
    t.print('  --json                 machine readable output (where supported)');
    t.print('  --no-color             disable colours (also NO_COLOR=1)');
    t.print('  -y, --yes              do not ask for confirmation');
    t.print('  --timeout <seconds>    network timeout');
    t.print('  --debug                show stack traces');
    t.print();
    return;
  }
  t.title(`MeshctCLI ${VERSION}`, 'Command line client for MeshCentral');
  t.section('Usage');
  t.print(`  mesh ${t.c.cyan('<device>')}               open a shell on a device (PowerShell on Windows)`);
  t.print(`  mesh                        pick a device interactively`);
  t.print(`  mesh ${t.c.cyan('<command>')} [arguments]`);
  for (const [group, cmds] of GROUPS) {
    t.section(group);
    for (const c of cmds) t.print(`  ${t.c.green(c.name.padEnd(12))} ${c.summary}`);
  }
  t.print();
  t.print(t.c.dim('  Device names are case-insensitive and may be partial. Run "mesh help <command>" for details.'));
  t.print(t.c.dim('  Global: -p/--profile <name>, --json, --no-color, -y/--yes, --timeout <s>, --debug'));
  t.print();
}

function deviceNamesForCompletion(profileName) {
  try {
    const config = loadConfig();
    const name = profileName || process.env.MESHCLI_PROFILE || config.defaultProfile || Object.keys(config.profiles)[0];
    return name ? completionNames(name) : [];
  } catch { return []; }
}

function runCompletion(argv) {
  const cword = Number(argv[0]);
  const words = argv.slice(1);
  if (!Number.isInteger(cword) || cword < 1) return;
  while (words.length < cword) words.push('');
  const commands = [...COMMANDS.values()].filter((c, i, all) => all.indexOf(c) === i).map((c) => c.name);
  const out = complete(words, cword, {
    commands,
    deviceNames: deviceNamesForCompletion,
    profiles: () => { try { return Object.keys(loadConfig().profiles); } catch { return []; } },
  });
  if (out.length) process.stdout.write(`${out.join('\n')}\n`);
}

function applyUiSettings(flags) {
  let colorPref;
  let unicodePref;
  try { const ui = loadConfig().ui; colorPref = ui.color; unicodePref = ui.unicode; } catch { /* use defaults */ }
  const flag = flags.color ?? (colorPref === 'always' ? true : colorPref === 'never' ? false : undefined);
  t.configureTerminal({
    color: t.detectColor({ flag, stream: process.stdout }) && t.detectColor({ flag, stream: process.stderr }),
    unicode: unicodePref === true || unicodePref === 'always' ? true : unicodePref === false || unicodePref === 'never' ? false : t.detectUnicode(),
  });
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

export function closestCommand(word) {
  const w = word.toLowerCase();
  let best = null;
  for (const name of COMMANDS.keys()) {
    const dist = distance(w, name);
    if (dist <= (name.length >= 4 ? 2 : 1) && (!best || dist < best.dist)) best = { name, dist };
  }
  return best?.name || null;
}

export async function main(argv) {
  if (argv[0] === '__complete') { runCompletion(argv.slice(1)); return EXIT.OK; }
  const flags = scanGlobalFlags(argv);
  applyUiSettings(flags);
  let ctx = null;
  try {
    const { index, word } = splitCommand(argv);
    let command;
    let rest;
    let commandWord = word;
    if (index === -1) {
      const parsed = parseCommandArgs(argv, {});
      if (parsed.opts.version) { version.run(); return EXIT.OK; }
      if (parsed.opts.help) { printHelp(); return EXIT.OK; }
      command = shell; rest = argv; commandWord = 'shell'; // bare "mesh": interactive picker + shell
    } else if (COMMANDS.has(word.toLowerCase())) {
      command = COMMANDS.get(word.toLowerCase());
      rest = [...argv.slice(0, index), ...argv.slice(index + 1)];
    } else {
      command = shell; rest = argv; commandWord = 'shell'; // "mesh Lenovo3" == "mesh shell Lenovo3"
    }
    const { args, opts } = parseCommandArgs(rest, command);
    if (opts.help) { printHelp(command.name); return EXIT.OK; }
    if (opts.version) { version.run(); return EXIT.OK; }
    ctx = new Context({ options: { profile: opts.profile, timeout: opts.timeout, json: opts.json } });
    await command.run(ctx, { args, opts, commandWord });
    return process.exitCode ?? EXIT.OK;
  } catch (err) {
    const known = err instanceof MeshError;
    const typed = splitCommand(argv).word;
    if (known && err.exitCode === EXIT.NOT_FOUND && typed && !COMMANDS.has(typed.toLowerCase())) {
      const guess = closestCommand(typed);
      if (guess) err.hint = `Did you mean "mesh ${guess}"? (Unknown words are treated as device names.)`;
    }
    if (!known && flags.debug !== true) {
      t.printError(new MeshError(`Unexpected error: ${err?.message || err}`, { hint: 'Run again with --debug for details.' }));
    } else t.printError(err, { debug: flags.debug });
    return known ? err.exitCode : EXIT.ERROR;
  } finally {
    ctx?.close();
  }
}
