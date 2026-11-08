param(
    [Parameter(Mandatory = $true)]
    [string]$ServerUrl,
    [ValidateRange(1, 1440)]
    [int]$IntervalMinutes = 15,
    [string]$AgentPath
)

$ErrorActionPreference = "Stop"

if (-not $AgentPath) {
    $candidates = @(
        (Join-Path $PSScriptRoot "statofact-agent-windows.exe")
        (Join-Path $PSScriptRoot "dist\statofact-agent-windows.exe")
        (Join-Path $PSScriptRoot "statofact-agent-windows.py")
    )
    $AgentPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $AgentPath -or -not (Test-Path -LiteralPath $AgentPath -PathType Leaf)) {
    throw "Windows-Agent nicht gefunden: $AgentPath"
}
$AgentPath = (Resolve-Path -LiteralPath $AgentPath).Path
if ($ServerUrl -notmatch '^https?://[^/\s]') {
    throw "ServerUrl muss mit http:// oder https:// beginnen."
}

switch ([IO.Path]::GetExtension($AgentPath).ToLowerInvariant()) {
    ".exe" {
        $executable = $AgentPath
        $agentArgument = ""
    }
    ".py" {
        $python = Get-Command python.exe -ErrorAction SilentlyContinue
        if (-not $python) {
            throw "Python 3 wurde nicht gefunden. Installieren Sie Python oder verwenden Sie die EXE."
        }
        $executable = $python.Source
        $agentArgument = "`"$AgentPath`" "
    }
    default {
        throw "AgentPath muss eine .exe- oder .py-Datei sein."
    }
}

$secureToken = Read-Host "StatoFact-Agent-Token" -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
}
if ($token.Length -lt 16) {
    throw "Das Token muss mindestens 16 Zeichen lang sein."
}

$configDirectory = Join-Path $env:LOCALAPPDATA "StatoFact"
$configPath = Join-Path $configDirectory "agent.conf"
$taskName = "StatoFact Windows Agent"
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null

$config = @(
    "STATOFACT_URL=$($ServerUrl.TrimEnd('/'))"
    "STATOFACT_TOKEN=$token"
)
[System.IO.File]::WriteAllLines($configPath, $config, [System.Text.UTF8Encoding]::new($false))
$token = $null
$secureToken.Dispose()

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $configPath
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @(
    $user
    [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
    [System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $configPath -AclObject $acl

$action = New-ScheduledTaskAction `
    -Execute $executable `
    -Argument "${agentArgument}--config `"$configPath`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Windows-Agent installiert. Aufgabe '$taskName' meldet alle $IntervalMinutes Minuten."
Write-Host "Konfiguration liegt benutzergeschützt unter: $configPath"
