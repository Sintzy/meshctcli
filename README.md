<h1 align="center">MeshctCLI</h1>

<p align="center">
  Control every machine on your <a href="https://github.com/Ylianst/MeshCentral">MeshCentral</a> server from the terminal.<br>
  Shell, remote desktop, files and power actions, with one command: <code>mesh</code>.
</p>

<p align="center">
  <a href="https://github.com/Sintzy/meshctCLI/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/Sintzy/meshctCLI?style=flat-square"></a>
  <a href="https://github.com/Sintzy/meshctCLI/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Sintzy/meshctCLI/ci.yml?branch=main&style=flat-square&label=tests"></a>
  <a href="https://github.com/Sintzy/meshctCLI/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/Sintzy/meshctCLI/total?style=flat-square"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-informational?style=flat-square">
  <img alt="MeshCentral" src="https://img.shields.io/badge/MeshCentral-1.3.1-blue?style=flat-square">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-orange?style=flat-square"></a>
</p>

```console
$ mesh list

MeshCentral  admin@mesh.example.com:443

  OK    3 devices: 2 online, 1 offline

Servers (3)
    OK    office-pc   · windows
    OK    web-server  · linux
    SKIP  lab-vm      · linux · offline
```

```console
$ mesh Lenovo3                                  # PowerShell on Windows, a shell elsewhere
$ mesh web Lenovo3                              # remote desktop in its own Chrome window
$ mesh upload Lenovo3 ./report.pdf "C:\Temp"    # real progress, speed and ETA
$ mesh                                          # no argument: pick a device with search
```

## Install

**Requires [Node.js](https://nodejs.org/) 18.17 or newer.** MeshctCLI never installs or downloads Node.js:
if it is missing or too old, the installer stops and tells you so. Otherwise it downloads one small file
(about 300 KB), verifies its SHA-256 checksum, adds the `mesh` command to your `PATH` and sets up Tab completion.

**macOS / Linux**

```sh
curl -fsSL https://github.com/Sintzy/meshctCLI/releases/latest/download/install.sh | sh
```

**Windows (PowerShell)**

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://github.com/Sintzy/meshctCLI/releases/latest/download/install.ps1 | iex
```

The first part enables TLS 1.2, which Windows PowerShell 5.1 needs to talk to GitHub; it is harmless on PowerShell 7.

Then:

```sh
mesh configure    # server URL, user, browser, default shell
mesh login        # password (+ 2FA) once; a revocable token goes into your OS keyring
mesh list
```

<details>
<summary>Other ways to install, update and remove</summary>

- **npm**: `npm install -g meshcentral-cli`
- **From source**: `npm install && npm run build`, then `node dist/mesh.cjs install`
- **Update**: run the installer again.
- **Pin a version**: `MESHCLI_VERSION=v1.0.0` before the installer command.
- **Remove**: `mesh uninstall` (add `--purge` to also delete profiles, stored logins and caches).

</details>

## Features

| | |
|---|---|
| **Shell** | `mesh <device>` opens PowerShell on Windows and a shell elsewhere. Resizes, Unicode, Ctrl+C and `Enter ~ .` to disconnect. `--user` runs as the logged-in user instead of the agent account. |
| **Remote desktop** | `mesh web <device>` opens the Desktop panel straight into a standalone Chrome/Edge/Brave app window: no tabs, no address bar. |
| **Files** | `upload`, `download` and an interactive explorer (`mesh files`). Progress, speed and ETA come from real byte counts. Nothing is overwritten without asking; downloads land in a `.part` file first. |
| **Devices** | Case- and accent-insensitive partial names, groups, filters (`--os`, `--online`, `--group`), picker with incremental search. |
| **Commands** | `mesh run <device> "cmd"` on one device or a whole group (`--group`), `--json` output. |
| **Tunnels** | `mesh tunnel` forwards a local TCP port; `mesh rdp` opens your native RDP client through it. |
| **Actions** | toast, message box, open URL, restart / shutdown / sleep (confirmation required), Wake-on-LAN. |
| **Profiles** | Several MeshCentral servers: `mesh -p work list`. |
| **Completion** | zsh, bash, fish, PowerShell. Device names come from a local cache, so Tab never touches the network. |
| **Doctor** | `mesh doctor [device]` checks config, keyring, TLS, login, device list and a relay tunnel. |

All commands: `mesh help`. Per-command usage: `mesh help <command>`.

## Security

- **TLS is verified.** For a self-signed server, `mesh configure` shows the certificate fingerprint and
  can pin it; the pin is checked before any credential is sent. `--ca <pem>` is also supported.
  Disabling verification needs an explicit `--insecure`.
- **Your password is never stored.** `mesh login` asks the server for a MeshCentral *login token*
  (revocable, optional expiry) and stores only that: macOS Keychain, Windows Credential Manager or the
  Linux Secret Service. Secrets are passed to those tools through stdin, never as arguments.
  Revoke in *My Account › Login Tokens* or with `mesh logout --revoke`.
- No shell is involved when launching browsers or tools, so device names with spaces or quotes are safe.
- Destructive actions ask for confirmation; in scripts they require `--yes`.
- For automation: `MESHCLI_USER`, `MESHCLI_PASSWORD`, `MESHCLI_2FA`.

## Remote desktop in a browser window

MeshCentral has no documented URL for "open the desktop", so MeshctCLI only uses mechanisms the server
already provides:

1. `/?node=<id>&viewmode=11&hide=23` is the link the web UI itself uses for "open in new window".
   `viewmode=11` is the Desktop panel and `hide=23` removes the header, tabs, footer and side menu.
2. If the server sets `"allowLoginToken": true`, the control channel issues a one-hour login cookie, so
   the window opens already signed in. It is handed over through a short-lived local redirect page and
   never appears on the browser's command line.
3. Chrome, Edge, Chromium or Brave start with `--app=<url>` and a dedicated profile.

Limits: there is no URL parameter that starts the connection, so you click **Connect** once. Without
`allowLoginToken` you sign in once in that window and the profile remembers it. Firefox has no app mode.

## Exit codes

`0` ok · `1` error · `2` usage · `3` authentication · `4` device not found or ambiguous ·
`5` network / TLS · `6` device offline · `130` cancelled.

## Development

```sh
npm install
npm test                                     # unit tests + an in-process mock MeshCentral
node scripts/integration.mjs <device> --write   # checks against YOUR server (cleans up after itself)
npm run build                                # single file dist/mesh.cjs
```

`npm run build` produces `dist/mesh.cjs`, one file that runs on every OS with Node.js 18.17+. Pushing a tag
`v*` runs [`release.yml`](.github/workflows/release.yml): tests, build, a smoke test on Linux, macOS and
Windows with Node 18 and 24, then the release with the installer scripts. The code is split by concern (`src/mesh` protocol and devices, `src/session` shell,
files and tunnels, `src/auth` keyrings, `src/ui` terminal output, `src/commands`).

What is and is not verified yet is tracked honestly in [TEST-RESULTS.md](TEST-RESULTS.md).

## Notes

MeshctCLI talks to MeshCentral's control and relay protocol directly, the same one the web UI and the
official `meshctrl` use. That protocol is not a formally versioned API, so every message used was
checked against the MeshCentral 1.3.1 source. This project is not affiliated with MeshCentral.

## License

MeshctCLI is **source-available, not open source**. It is licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE): you may use, study, change and share it for any
noncommercial purpose (personal use, hobby projects, research, education, charities and similar
organizations). **You may not use it commercially or sell it**, and that includes selling the software, a modified version of it, or a service built on it. For a commercial license, contact the author through the
[GitHub repository](https://github.com/Sintzy/meshctCLI).

Bundled third-party software and its licenses: [THIRD-PARTY.md](THIRD-PARTY.md). This project is not
affiliated with MeshCentral.
