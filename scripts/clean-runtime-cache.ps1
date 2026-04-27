$ErrorActionPreference = 'Stop'

$appDataRoot = Join-Path $env:LOCALAPPDATA 'com.kerbodyne.groundstation'
$cachePath = Join-Path $appDataRoot 'EBWebView'

if (Test-Path -LiteralPath $cachePath) {
    Write-Host "Removing $cachePath"
    Remove-Item -LiteralPath $cachePath -Recurse -Force
}
else {
    Write-Host "Skipping missing path $cachePath"
}

Write-Host 'Runtime cache cleanup complete. Offline maps, alerts, and the session database were preserved.'
