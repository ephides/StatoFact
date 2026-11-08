param(
    [string]$Python = "python",
    [string]$InnoCompiler = "${env:ProgramFiles}\Inno Setup 7\ISCC.exe"
)

$ErrorActionPreference = "Stop"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) {
    throw ".NET Framework C#-Compiler nicht gefunden: $csc"
}
if (-not (Test-Path -LiteralPath $InnoCompiler -PathType Leaf)) {
    throw "Inno Setup-Compiler nicht gefunden: $InnoCompiler. Mit -InnoCompiler den Pfad angeben."
}

& (Join-Path $PSScriptRoot "build-windows.ps1") -Python $Python
$service = Join-Path $PSScriptRoot "dist\statofact-agent-service.exe"
$source = Join-Path $PSScriptRoot "windows-service.cs"
& $csc /nologo /target:exe /platform:x64 /optimize+ /codepage:65001 "/out:$service" `
    /reference:System.ServiceProcess.dll $source
if ($LASTEXITCODE -ne 0) {
    throw "Der Windows-Dienst konnte nicht erstellt werden (Exit-Code $LASTEXITCODE)."
}
& $InnoCompiler (Join-Path $PSScriptRoot "statofact-windows-setup.iss")
if ($LASTEXITCODE -ne 0) {
    throw "Der Inno-Setup-Installer konnte nicht erstellt werden (Exit-Code $LASTEXITCODE)."
}
Write-Host "Installer erstellt: $(Join-Path $PSScriptRoot 'dist\StatoFact-Agent-Setup.exe')"
