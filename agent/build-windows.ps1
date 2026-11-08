param(
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$agentPath = Join-Path $PSScriptRoot "statofact-agent-windows.py"
$distPath = Join-Path $PSScriptRoot "dist"
$workPath = Join-Path $PSScriptRoot "build\windows"

& $Python -m PyInstaller --noconfirm --onefile --console `
    --name statofact-agent-windows `
    --distpath $distPath --workpath $workPath --specpath $workPath `
    $agentPath
if ($LASTEXITCODE -ne 0) {
    throw "Der Windows-Agent konnte nicht erstellt werden (Exit-Code $LASTEXITCODE)."
}
Write-Host "Windows-Agent erstellt: $(Join-Path $distPath 'statofact-agent-windows.exe')"
