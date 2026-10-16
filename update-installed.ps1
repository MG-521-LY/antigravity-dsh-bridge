[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)] [string]$InstallDir,
    [string]$NodePath
)
$ErrorActionPreference = 'Stop'
function Stop-CheckedProcess($Expected) {
    $currentProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Expected.ProcessId)
    if (-not $currentProcess) { return }
    if ($currentProcess.CreationDate -ne $Expected.CreationDate -or $currentProcess.ExecutablePath -ne $Expected.ExecutablePath) {
        throw 'Process identity changed during update; refusing to stop it.'
    }
    try { Stop-Process -Id $Expected.ProcessId -ErrorAction Stop }
    catch { if (Get-Process -Id $Expected.ProcessId -ErrorAction SilentlyContinue) { throw } }
}
$sourceDir = $PSScriptRoot
$targetDir = (Resolve-Path -LiteralPath $InstallDir).Path
if ($targetDir -eq $sourceDir) { throw 'Run this updater from a separate, updated source checkout.' }
$configPath = Join-Path $targetDir 'config.yaml'
if (-not (Test-Path -LiteralPath $configPath) -or
    -not (Test-Path -LiteralPath (Join-Path $targetDir 'bin\cli-proxy-api.exe'))) {
    throw 'The destination is not an existing bridge installation.'
}
if (-not $NodePath) {
    $nodeFile = Join-Path $sourceDir 'node-path.txt'
    if (Test-Path -LiteralPath $nodeFile) { $NodePath = Get-Content -LiteralPath $nodeFile -Encoding Unicode | Select-Object -First 1 }
    else { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
}
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$files = @('lazy-api.cjs','bridge-supervisor.cjs','cleanup-backend.ps1','start-bridge.vbs','memory-status.vbs','01-login.cmd','02-start-api.cmd',
    'setup.ps1','config.example.yaml','verify-lazy-api.cjs','README.md','LICENSE','.gitignore','.gitattributes',
    'lib\usage.cjs','lib\dashboard.cjs','lib\dsh-reader.cjs','lib\lifecycle.cjs','lib\memory.cjs',
    'web\index.html','web\style.css','web\app.js','tests\dashboard.test.cjs','tests\lifecycle.test.cjs')
foreach ($relative in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDir $relative))) { throw "Missing source file: $relative" }
}
if (-not $PSCmdlet.ShouldProcess($targetDir, 'Back up code, stop only the verified local bridge, and install dashboard update')) { return }

$supervisorLock = Join-Path $targetDir 'supervisor-lock.json'
$supervisorProcess = $null
if (Test-Path -LiteralPath $supervisorLock) {
    $supervisorState = Get-Content -LiteralPath $supervisorLock -Raw | ConvertFrom-Json
    $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$supervisorState.pid)
    if ($candidate) {
        if ($candidate.ExecutablePath -ne $NodePath -or -not $candidate.CommandLine -or
            $candidate.CommandLine.IndexOf((Join-Path $targetDir 'bridge-supervisor.cjs'), [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw 'Supervisor lock belongs to an unrecognized process. Nothing was stopped.'
        }
        $supervisorProcess = $candidate
    }
}
$listener = Get-NetTCPConnection -State Listen -LocalPort 8317 -ErrorAction SilentlyContinue | Select-Object -First 1
$maintenancePath = Join-Path $targetDir '.bridge-maintenance'
try {
if ($listener) {
    $front = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
    $previewStatePath = Join-Path $sourceDir '.runtime\bridge-state.json'
    $previewState = if (Test-Path -LiteralPath $previewStatePath) { Get-Content -LiteralPath $previewStatePath -Raw | ConvertFrom-Json } else { $null }
    $normalEntry = $front.CommandLine -and $front.CommandLine.IndexOf((Join-Path $targetDir 'lazy-api.cjs'), [StringComparison]::OrdinalIgnoreCase) -ge 0
    $previewEntry = $previewState -and $previewState.pid -eq $front.ProcessId -and
        ($front.CommandLine -match '\.local[\\/]serve-preview\.cjs')
    if ($front.ExecutablePath -ne $NodePath -or (-not $normalEntry -and -not $previewEntry)) {
        throw 'Port 8317 belongs to an unrecognized process. Nothing was stopped.'
    }
    try {
        $current = Invoke-RestMethod -Uri 'http://127.0.0.1:8317/dashboard/api/stats?range=1' -TimeoutSec 3
        if ($current.bridge.status.activeRequests -gt 0) { throw 'A model request is active; update after it finishes.' }
    } catch {
        throw 'Cannot establish that the bridge is idle. Nothing was stopped.'
    }
    $backendListener = Get-NetTCPConnection -State Listen -LocalPort 8318 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($backendListener) {
        $child = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $backendListener.OwningProcess)
        if ($child.ParentProcessId -ne $front.ProcessId -or
            $child.ExecutablePath -ne (Join-Path $targetDir 'bin\cli-proxy-api.exe')) {
            throw 'Port 8318 belongs to an unrecognized process. Nothing was stopped.'
        }
    }
    Set-Content -LiteralPath $maintenancePath -Value 'Installing bridge update'
    # Stop the verified supervisor first so it cannot restart the entry during installation.
    if ($supervisorProcess) { Stop-CheckedProcess $supervisorProcess; $supervisorProcess = $null }
    if ($backendListener) { Stop-CheckedProcess $child }
    Stop-CheckedProcess $front
}
if ($supervisorProcess) {
    Set-Content -LiteralPath $maintenancePath -Value 'Installing bridge update'
    Stop-CheckedProcess $supervisorProcess
}

$configHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
$backupDir = Join-Path $targetDir ('backups\dashboard-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
foreach ($relative in $files) {
    $destination = Join-Path $targetDir $relative
    if (Test-Path -LiteralPath $destination) {
        $backupFile = Join-Path $backupDir $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $backupFile) -Force | Out-Null
        Copy-Item -LiteralPath $destination -Destination $backupFile
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceDir $relative) -Destination $destination -Force
}
Set-Content -LiteralPath (Join-Path $targetDir 'node-path.txt') -Value $NodePath -Encoding Unicode
if ($configHash -ne (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash) {
    throw 'Configuration hash changed unexpectedly; inspect the installation before starting.'
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$launcher = Join-Path $targetDir 'start-bridge.vbs'
$startupCommand = '"' + $wscript + '" //B //Nologo "' + $launcher + '"'
New-ItemProperty -LiteralPath $runKey -Name 'AntigravityDshBridge' -PropertyType String -Value $startupCommand -Force | Out-Null
} finally {
    if (Test-Path -LiteralPath $maintenancePath) { Remove-Item -LiteralPath $maintenancePath -Force }
}
Start-Process -FilePath $wscript -ArgumentList @('//B','//Nologo',('"' + $launcher + '"')) -WorkingDirectory $targetDir -WindowStyle Hidden
Write-Output 'Dashboard update installed. Account credentials and API configuration were preserved.'
Write-Output 'Open http://127.0.0.1:8317/dashboard/ . Code backups are in the installation backups directory.'
