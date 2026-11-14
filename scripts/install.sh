#!/bin/sh
# MeshctCLI one-line installer for macOS and Linux:
#   curl -fsSL https://github.com/Sintzy/meshctCLI/releases/latest/download/install.sh | sh
#
# MeshctCLI REQUIRES Node.js 18.17+ and never installs it for you. If Node.js is missing or too
# old, this script stops. Otherwise it downloads mesh.cjs (a ~300 KB file), verifies its SHA-256
# checksum, then runs "mesh install" (command on your PATH + Tab completion).
set -eu

REPO="${MESHCLI_REPO:-Sintzy/meshctCLI}"   # GitHub "owner/repo" that hosts the releases
VERSION="${MESHCLI_VERSION:-latest}"

# --- Node.js is required ------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo " FAIL   Node.js is required but was not found." >&2
  echo "        Install Node.js 18.17 or newer from https://nodejs.org/ and run this again." >&2
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>18||(a===18&&b>=17)?0:1)'; then
  echo " FAIL   Node.js $(node -v) is too old; MeshctCLI needs 18.17 or newer." >&2
  echo "        Update it from https://nodejs.org/ and run this again." >&2
  exit 1
fi

if [ -n "${MESHCLI_BASE_URL:-}" ]; then base="$MESHCLI_BASE_URL"   # mirror / testing
elif [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"
else base="https://github.com/$REPO/releases/download/$VERSION"; fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT INT TERM
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -q "$1" -O "$2"; fi; }

echo "  INFO  Using Node.js $(node -v). Downloading MeshctCLI ..."
fetch "$base/mesh.cjs" "$tmp/mesh.cjs" || { echo " FAIL   Download failed: $base/mesh.cjs" >&2; exit 1; }
fetch "$base/mesh.cjs.sha256" "$tmp/mesh.cjs.sha256" || { echo " FAIL   Checksum download failed." >&2; exit 1; }

expected="$(cut -d' ' -f1 "$tmp/mesh.cjs.sha256")"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/mesh.cjs" | cut -d' ' -f1)"
else actual="$(shasum -a 256 "$tmp/mesh.cjs" | cut -d' ' -f1)"; fi
[ "$expected" = "$actual" ] || { echo " FAIL   Checksum mismatch; refusing to install." >&2; exit 1; }

node "$tmp/mesh.cjs" install
