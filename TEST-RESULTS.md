# MeshCLI test results — 2026-11-14

Environment: macOS 26.6 (Apple Silicon), Node.js 24.19.0, zsh 5.9, GNU bash 5.3.

There are three levels of evidence below. They are kept separate on purpose.

## 1. Automated tests: `npm test` (30/30 passing)

Run without any server.

| Kind | What is covered |
|---|---|
| Unit | URL normalisation (domains, `?key=`, wss→https), OS detection, device matching (exact > prefix > substring, case/accent-insensitive, `id:`), filters, argument parsing and usage errors, completion engine, rc-file patching (idempotent, legacy line disabled), badges with and without colour, colour detection, picker ranking/paging, progress (no % without a known total), files-protocol helpers, auth header, close-message → error mapping, shell protocol choice, typo suggestions |
| **Simulated** server (in-process mock of `control.ashx` + `meshrelay.ashx`) | login header, wrong password, 2FA required then accepted, device list, run command (ok + agent-offline error), login cookie (present / silently missing), login token create + login with it, relay tunnel handshake (`rauth`/`auth` cookies), file session ls / upload with 0x00/`{` escaping / multi-block download / agent refusal / `.part` cleanup, TCP tunnel echo |
| Real TLS (local `https` server, self-signed certificate from `openssl`) | untrusted certificate rejected **before** credentials are sent; pinned fingerprint accepted; wrong pin rejected without sending credentials |
| CLI subprocess | help/version, unknown option → exit 2, `__complete` answers from cache only (unroutable server configured), not logged in in a script → exit 3 without prompting |
| Storage | config save/load (mode 0600), profile resolution, env-variable credentials, file credential store round trip, token expiry |

The mock server is a simulation. It shows that MeshCLI follows the protocol as I read it in the
MeshCentral source. It does **not** prove that a real server behaves the same, which is what
section 2 is for.

## 2. Real MeshCentral 1.3.1 server + real agent (local, temporary)

A **real** MeshCentral 1.3.1 server (the npm package already in `~/meshctrl`) ran on
`https://localhost:18443` with a test account. A **real MeshAgent** (macOS arm64 build served by
that server) ran in the foreground on this Mac, connected only to that local server. Both were
stopped and deleted afterwards.

| Feature | Result |
|---|---|
| `mesh configure` with a self-signed certificate: refused without pinning, then pinned by fingerprint | ✅ |
| `mesh login`: wrong password → exit 3; correct password → login token created, stored in the **macOS Keychain**, verified | ✅ |
| `mesh status`, `mesh doctor` (keyring, browser, TLS pin, auth, devices, login cookie, legacy `.zshrc` line found) | ✅ |
| `mesh list` / `--json`, `mesh info` (hardware, network, last connection) | ✅ |
| `mesh run` (output with UTF-8 `olá ünïcode ✓`), `--json`, unknown device → exit 4 + "did you mean" | ✅ |
| Interactive `mesh <device>` in a pseudo-terminal: prompt, commands, `exit`, UTF-8 input/output | ✅ |
| Bare `mesh` → picker with incremental search → Enter → shell | ✅ |
| `mesh upload` 4 files at once (25 MB random, file starting with `{`, file starting with 0x00, empty file): byte-identical | ✅ |
| Upload over an existing file without `--force` in a script → refused (exit 130) | ✅ |
| `mesh download` 25 MB and 286 MB: byte-identical; real %, speed and ETA shown | ✅ |
| Download: missing file → exit 4; folder → clear error; empty file | ✅ |
| `mesh files --list` | ✅ |
| `mesh tunnel` (two HTTP requests through the agent to a local port) | ✅ |
| `mesh restart` in a script without `--yes` → refused (exit 2). Never actually run. | ✅ |
| `mesh web --print-url` → opened in a browser: **signed in automatically**, landed directly on *Desktop – <device>*, header/tabs/menus hidden | ✅ (screenshot taken). The Connect click itself was not tested: the agent was offline in that run |
| `scripts/integration.mjs --write` (11 checks) | ✅ 11/11 |
| zsh Tab completion in an interactive zsh: `mesh web mac<Tab>` → `macdemiguel.local`, `mesh upl<Tab>` → `upload` | ✅ |
| bash completion function: devices, commands, file fallback | ✅ |
| `mesh completion install/uninstall` (temporary HOME): one line added, idempotent, backup made, prototype line disabled | ✅ |
| `npm pack` + `npm install -g` into a temporary prefix: `mesh` and `meshcli` work | ✅ |

## 2b. Real production server (run by the project owner, 2026-11-14)

| Check | Result |
|---|---|
| `mesh configure` (ZeroSSL certificate trusted) and `mesh login` → token stored in the macOS Keychain | OK |
| `mesh list` (15 devices), `info`, `files --list` (relay tunnel), `web --print-url` with login cookie | OK |
| `run whoami`, piped shell, upload on **Lenovo3** | FAILED: the device reports "Microsoft Hyper-V Server - 17763", which has no "Windows" in its description, so it was treated as Linux. **Fixed** (agent architecture id is now authoritative, unit test added). Needs re-running. |

## 3. Not verified yet. Do not treat these as done.

| Item | Why | How to verify |
|---|---|---|
| The owner's production server and a real Windows device | I don't use your real password | `mesh configure`, `mesh login`, then `node scripts/integration.mjs Lenovo3 --write` |
| PowerShell / CMD sessions on a Windows agent, `NT AUTHORITY\SYSTEM` vs `--user` | there was no Windows agent locally | `mesh Lenovo3`, `mesh cmd Lenovo3`, `mesh Lenovo3 --user` then `whoami` |
| Remote desktop actually streaming in the Chrome app window | needs a device with a desktop session | `mesh web Lenovo3` → Connect |
| `mesh rdp` (native client) | needs Windows with RDP enabled | `mesh rdp Lenovo3` |
| Windows Credential Manager, Windows browser paths, `mstsc` | written from the Win32 API docs, not run | `mesh login` + `mesh doctor` on Windows |
| Linux Secret Service (`secret-tool`), Linux browsers, `xfreerdp`/`remmina` | not run | `mesh doctor` on Linux |
| fish and PowerShell completion scripts | fish/pwsh not installed here | `mesh completion install fish` / `powershell` |
| Toast, message box, open URL, power, wake, web relay | messages are taken from `meshctrl.js`/`meshuser.js`; not sent so the test Mac wouldn't be disturbed (power) or because web relay needs extra server configuration | try on a test device |
| Email/SMS 2FA code requests | the server had no mail/SMS configured | an account with email 2FA |
