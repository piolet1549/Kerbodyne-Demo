$ErrorActionPreference = 'Stop'

$runtimeVersion = '1.26.8'
$runtimeArch = 'x86_64'
$runtimeUrl = "https://gstreamer.freedesktop.org/data/pkg/windows/$runtimeVersion/msvc/gstreamer-1.0-msvc-$runtimeArch-$runtimeVersion.msi"

$repoRoot = Split-Path -Parent $PSScriptRoot
$resourcesRoot = Join-Path $repoRoot 'src-tauri\resources'
$runtimeRoot = Join-Path $resourcesRoot 'gstreamer'
$runtimeBin = Join-Path $runtimeRoot 'bin\gst-launch-1.0.exe'

if (Test-Path $runtimeBin) {
  Write-Host "GStreamer runtime already prepared at $runtimeRoot"
  exit 0
}

New-Item -ItemType Directory -Force -Path $resourcesRoot | Out-Null

$cacheRoot = Join-Path $repoRoot '.cache\gstreamer'
$msiPath = Join-Path $cacheRoot "gstreamer-runtime-$runtimeVersion-$runtimeArch.msi"
$extractRoot = Join-Path $cacheRoot "extract-$runtimeVersion-$runtimeArch"

New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
if (-not (Test-Path $msiPath)) {
  Write-Host "Downloading GStreamer runtime $runtimeVersion ($runtimeArch)..."
  Invoke-WebRequest -Uri $runtimeUrl -OutFile $msiPath
}

if (Test-Path $extractRoot) {
  Remove-Item -Recurse -Force $extractRoot
}
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

Write-Host 'Extracting GStreamer runtime package...'
$msiArguments = @(
  '/a'
  "`"$msiPath`""
  '/qn'
  "TARGETDIR=`"$extractRoot`""
)
$process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArguments -Wait -PassThru -WindowStyle Hidden
if ($process.ExitCode -ne 0) {
  throw "GStreamer MSI extraction failed with exit code $($process.ExitCode)."
}

$gstLaunch = Get-ChildItem -Path $extractRoot -Filter 'gst-launch-1.0.exe' -Recurse -File | Select-Object -First 1
if (-not $gstLaunch) {
  throw 'Unable to locate gst-launch-1.0.exe after extracting the GStreamer runtime.'
}

$extractedRoot = Split-Path -Parent (Split-Path -Parent $gstLaunch.FullName)
if (Test-Path $runtimeRoot) {
  Remove-Item -Recurse -Force $runtimeRoot
}
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
Copy-Item -Path (Join-Path $extractedRoot '*') -Destination $runtimeRoot -Recurse -Force

if (-not (Test-Path $runtimeBin)) {
  throw "Prepared runtime is missing gst-launch-1.0.exe at $runtimeBin"
}

Write-Host "Prepared bundled GStreamer runtime at $runtimeRoot"
