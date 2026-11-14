# MeshCLI one-line installer for Windows (PowerShell 5.1+ / 7):
#   [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://github.com/Sintzy/meshctCLI/releases/latest/download/install.ps1 | iex
#
# MeshCLI REQUIRES Node.js 18.17+ and never installs it for you. If Node.js is missing or too
# old, this script stops. Otherwise it downloads mesh.cjs (a ~300 KB file), verifies its SHA-256
# checksum, then runs "mesh install" (mesh command on your user PATH + Tab completion).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar of Windows PowerShell 5.1 makes downloads many times slower
# Windows PowerShell 5.1 defaults to TLS 1.0/1.1, which GitHub rejects ("connection was closed unexpectedly").
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$Repo = if ($env:MESHCLI_REPO) { $env:MESHCLI_REPO } else { 'Sintzy/meshctCLI' }
$Version = if ($env:MESHCLI_VERSION) { $env:MESHCLI_VERSION } else { 'latest' }

# --- Node.js is required ------------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host ' FAIL   Node.js is required but was not found.' -ForegroundColor Red
    Write-Host '        Install Node.js 18.17 or newer from https://nodejs.org/ and run this again.'
    return
}
$nodeVersion = (& node -v).TrimStart('v')
if ([version]($nodeVersion -replace '-.*$', '') -lt [version]'18.17.0') {
    Write-Host " FAIL   Node.js v$nodeVersion is too old; MeshCLI needs 18.17 or newer." -ForegroundColor Red
    Write-Host '        Update it from https://nodejs.org/ and run this again.'
    return
}

$base = if ($env:MESHCLI_BASE_URL) { $env:MESHCLI_BASE_URL } elseif ($Version -eq 'latest') { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/$Version" }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("meshcli-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $file = Join-Path $tmp 'mesh.cjs'
    Write-Host "  INFO  Using Node.js v$nodeVersion. Downloading MeshCLI ..."
    Invoke-WebRequest "$base/mesh.cjs" -OutFile $file -UseBasicParsing
    $expected = ((Invoke-WebRequest "$base/mesh.cjs.sha256" -UseBasicParsing).Content.ToString().Trim() -split '\s+')[0]
    $actual = (Get-FileHash $file -Algorithm SHA256).Hash
    if ($expected.ToLower() -ne $actual.ToLower()) { Write-Host ' FAIL   Checksum mismatch; refusing to install.' -ForegroundColor Red; return }
    & node $file install
} finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
