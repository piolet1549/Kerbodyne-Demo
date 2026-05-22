$ErrorActionPreference = 'Stop'

$runtimeVersion = '3.0.23'
$archiveName = "vlc-$runtimeVersion-win64.zip"
$downloadUrls = @(
  "https://mirror.fcix.net/videolan-ftp/vlc/$runtimeVersion/win64/$archiveName",
  "https://plug-mirror.rcac.purdue.edu/vlc/vlc/$runtimeVersion/win64/$archiveName",
  "https://opencolo.mm.fcix.net/videolan-ftp/vlc/$runtimeVersion/win64/$archiveName"
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$resourcesRoot = Join-Path $repoRoot 'src-tauri\resources'
$runtimeRoot = Join-Path $resourcesRoot 'vlc'
$runtimeExe = Join-Path $runtimeRoot 'vlc.exe'
$runtimeDll = Join-Path $runtimeRoot 'libvlc.dll'
$runtimePlugins = Join-Path $runtimeRoot 'plugins'

function Test-ZipArchive {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return $false
  }

  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 4) {
    return $false
  }

  return $bytes[0] -eq 0x50 -and $bytes[1] -eq 0x4B
}

if ((Test-Path $runtimeExe) -and (Test-Path $runtimeDll) -and (Test-Path $runtimePlugins)) {
  Write-Host "VLC runtime already prepared at $runtimeRoot"
  exit 0
}

New-Item -ItemType Directory -Force -Path $resourcesRoot | Out-Null

$cacheRoot = Join-Path $repoRoot '.cache\vlc'
$zipPath = Join-Path $cacheRoot $archiveName
$extractRoot = Join-Path $cacheRoot "extract-$runtimeVersion-win64"

New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null

if (-not (Test-ZipArchive $zipPath)) {
  $downloaded = $false
  foreach ($url in $downloadUrls) {
    try {
      Write-Host "Downloading VLC runtime $runtimeVersion from $url ..."
      $partialPath = "$zipPath.download"
      Remove-Item $partialPath -Force -ErrorAction SilentlyContinue
      Invoke-WebRequest -Uri $url -OutFile $partialPath
      if ((Get-Item $partialPath).Length -lt 10000000) {
        throw "Downloaded archive is unexpectedly small."
      }
      if (-not (Test-ZipArchive $partialPath)) {
        throw "Downloaded file is not a valid ZIP archive."
      }
      Move-Item -Force $partialPath $zipPath
      $downloaded = $true
      break
    } catch {
      Write-Warning "Failed to download VLC runtime from $url : $_"
      Remove-Item "$zipPath.download" -Force -ErrorAction SilentlyContinue
    }
  }

  if (-not $downloaded) {
    throw "Unable to download VLC runtime $runtimeVersion from the configured mirrors."
  }
}

if (Test-Path $extractRoot) {
  Remove-Item -Recurse -Force $extractRoot
}
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

Write-Host 'Extracting VLC runtime archive...'
Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

$vlcExe = Get-ChildItem -Path $extractRoot -Filter 'vlc.exe' -Recurse -File | Select-Object -First 1
if (-not $vlcExe) {
  throw 'Unable to locate vlc.exe after extracting the VLC runtime archive.'
}

$extractedRoot = Split-Path -Parent $vlcExe.FullName
if (Test-Path $runtimeRoot) {
  Remove-Item -Recurse -Force $runtimeRoot
}
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
Copy-Item -Path (Join-Path $extractedRoot '*') -Destination $runtimeRoot -Recurse -Force

if (-not (Test-Path $runtimeExe)) {
  throw "Prepared runtime is missing vlc.exe at $runtimeExe"
}
if (-not (Test-Path $runtimeDll)) {
  throw "Prepared runtime is missing libvlc.dll at $runtimeDll"
}
if (-not (Test-Path $runtimePlugins)) {
  throw "Prepared runtime is missing the plugins directory at $runtimePlugins"
}

Write-Host "Prepared bundled VLC runtime at $runtimeRoot"
