$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$targets = @(
    (Join-Path $projectRoot '.tmp-debug'),
    (Join-Path $projectRoot 'dist'),
    (Join-Path $projectRoot 'src-tauri\target\debug')
)

foreach ($target in $targets) {
    if (Test-Path -LiteralPath $target) {
        Write-Host "Removing $target"
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    else {
        Write-Host "Skipping missing path $target"
    }
}

Write-Host 'Build artifact cleanup complete.'
