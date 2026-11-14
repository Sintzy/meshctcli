# MeshCLI one-line installer for Windows (PowerShell 5.1+ / 7):
#   irm https://github.com/Sintzy/meshctCLI/releases/latest/download/install.ps1 | iex
# Downloads the standalone mesh.exe, verifies its SHA-256 checksum, then runs "mesh install"
# (user PATH + Tab completion). No Node.js needed.
$ErrorActionPreference = 'Stop'
$Repo = if ($env:MESHCLI_REPO) { $env:MESHCLI_REPO } else { 'Sintzy/meshctCLI' }   # <-- GitHub "owner/repo"
$Version = if ($env:MESHCLI_VERSION) { $env:MESHCLI_VERSION } else { 'latest' }

if (-not $env:MESHCLI_BASE_URL -and $Repo -like 'OWNER/*') { Write-Host ' FAIL   Set $env:MESHCLI_REPO = "owner/repo" (or edit $Repo in this script).' -ForegroundColor Red; return }
if (-not [Environment]::Is64BitOperatingSystem) { Write-Host ' FAIL   64-bit Windows is required.' -ForegroundColor Red; return }

$name = 'mesh-win-x64.exe'
$base = if ($env:MESHCLI_BASE_URL) { $env:MESHCLI_BASE_URL } elseif ($Version -eq 'latest') { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/$Version" }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("meshcli-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $exe = Join-Path $tmp 'mesh.exe'
    Write-Host "  INFO  Downloading $name ..."
    Invoke-WebRequest "$base/$name" -OutFile $exe -UseBasicParsing
    $expected = ((Invoke-WebRequest "$base/$name.sha256" -UseBasicParsing).Content.ToString().Trim() -split '\s+')[0]
    $actual = (Get-FileHash $exe -Algorithm SHA256).Hash
    if ($expected.ToLower() -ne $actual.ToLower()) { Write-Host ' FAIL   Checksum mismatch; refusing to install.' -ForegroundColor Red; return }
    & $exe install
} finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
