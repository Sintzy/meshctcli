#!/bin/sh
# MeshCLI one-line installer for macOS and Linux:
#   curl -fsSL https://github.com/Sintzy/meshctCLI/releases/latest/download/install.sh | sh
# Downloads the standalone "mesh" executable for this machine, verifies its SHA-256 checksum,
# then runs "mesh install" (PATH + Tab completion). No Node.js needed.
set -eu

REPO="${MESHCLI_REPO:-Sintzy/meshctCLI}"   # <-- GitHub "owner/repo" that hosts the releases
VERSION="${MESHCLI_VERSION:-latest}"

[ -n "${MESHCLI_BASE_URL:-}" ] || case "$REPO" in OWNER/*) echo " FAIL   Set MESHCLI_REPO=owner/repo (edit REPO in this script before publishing)." >&2; exit 1;; esac

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) echo " FAIL   Unsupported OS: $(uname -s). On Windows use install.ps1." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) echo " FAIL   Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

name="mesh-$os-$arch"
if [ -n "${MESHCLI_BASE_URL:-}" ]; then base="$MESHCLI_BASE_URL"   # mirror / testing
elif [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"
else base="https://github.com/$REPO/releases/download/$VERSION"; fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT INT TERM
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -q "$1" -O "$2"; fi; }

echo "  INFO  Downloading $name ..."
fetch "$base/$name" "$tmp/mesh" || { echo " FAIL   Download failed: $base/$name" >&2; exit 1; }
fetch "$base/$name.sha256" "$tmp/mesh.sha256" || { echo " FAIL   Checksum download failed." >&2; exit 1; }

expected="$(cut -d' ' -f1 "$tmp/mesh.sha256")"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/mesh" | cut -d' ' -f1)"
else actual="$(shasum -a 256 "$tmp/mesh" | cut -d' ' -f1)"; fi
[ "$expected" = "$actual" ] || { echo " FAIL   Checksum mismatch; refusing to install." >&2; exit 1; }

chmod +x "$tmp/mesh"
"$tmp/mesh" install
