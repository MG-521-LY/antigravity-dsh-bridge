[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version = '8.0.29',
    [string]$NodePath,
    [string]$ProxyUrl = '',
    [switch]$SkipDownload,
    [switch]$NoAutostart,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer supports Windows only.' }
$projectDir = $PSScriptRoot

if (-not $NodePath) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Install Node.js 22 or later, or pass -NodePath with the path to node.exe.' }
    $NodePath = $nodeCommand.Source
}
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$nodeVersion = & $NodePath --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
    throw 'Node.js 22 or later is required.'
}
& $NodePath -e "if (typeof require('node:zlib').zstdDecompressSync !== 'function') process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'The dashboard needs Zstandard support. Use Node.js 22.15+ or Node.js 24 LTS.' }

$binaryDir = Join-Path $projectDir 'bin'
$executable = Join-Path $binaryDir 'cli-proxy-api.exe'
if (-not $SkipDownload) {
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    switch ($architecture) {
        'X64' { $assetArchitecture = 'amd64' }
        'Arm64' { $assetArchitecture = 'aarch64' }
        default { throw "Unsupported Windows architecture: $architecture" }
    }
    $downloadDir = Join-Path $projectDir '.downloads'
    New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
    $assetName = "CLIProxyAPI_${Version}_windows_${assetArchitecture}.zip"
    $releaseUrl = "https://github.com/router-for-me/CLIProxyAPI/releases/download/v$Version"
    $archivePath = Join-Path $downloadDir $assetName
    $checksumPath = Join-Path $downloadDir 'checksums.txt'
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$assetName" -OutFile $archivePath
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/checksums.txt" -OutFile $checksumPath
    $expectedLine = @(Get-Content -LiteralPath $checksumPath | Where-Object {
        $_ -match ('\s+\*?' + [regex]::Escape($assetName) + '$')
    })
    if ($expectedLine.Count -ne 1) { throw 'The release checksum entry is missing or ambiguous.' }
    $expectedHash = ($expectedLine[0] -split '\s+')[0]
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($expectedHash -ne $actualHash) { throw 'Archive checksum mismatch; installation stopped.' }
    New-Item -ItemType Directory -Path $binaryDir -Force | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $binaryDir -Force
}
if (-not (Test-Path -LiteralPath $executable)) { throw 'CLIProxyAPI executable not found.' }

New-Item -ItemType Directory -Path (Join-Path $projectDir 'auth') -Force | Out-Null
$configPath = Join-Path $projectDir 'config.yaml'
if (-not (Test-Path -LiteralPath $configPath)) {
    $randomBytes = New-Object byte[] 24
    $randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $randomGenerator.GetBytes($randomBytes) } finally { $randomGenerator.Dispose() }
    $localKey = 'ag-dsh-' + (($randomBytes | ForEach-Object { $_.ToString('x2') }) -join '')
    $authPath = (Join-Path $projectDir 'auth').Replace('\', '/').Replace("'", "''")
    $escapedProxy = $ProxyUrl.Replace("'", "''")
    $template = Get-Content -LiteralPath (Join-Path $projectDir 'config.example.yaml') -Raw
    $template = $template.Replace('replace-with-a-random-local-key', $localKey)
    $template = $template.Replace("auth-dir: './auth'", "auth-dir: '$authPath'")
    $template = $template.Replace("proxy-url: ''", "proxy-url: '$escapedProxy'")
    [System.IO.File]::WriteAllText($configPath, $template, (New-Object System.Text.UTF8Encoding($false)))
} else {
    Write-Output 'Existing config.yaml was preserved, including its API key and proxy settings.'
}
# UTF-16 is used so Windows Script Host can read paths containing Chinese characters.
Set-Content -LiteralPath (Join-Path $projectDir 'node-path.txt') -Value $NodePath -Encoding Unicode

if (-not $NoAutostart) {
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $entryName = 'AntigravityDshBridge'
    $launcher = Join-Path $projectDir 'start-bridge.vbs'
    $wscriptPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $startupCommand = '"' + $wscriptPath + '" //B //Nologo "' + $launcher + '"'
    $previous = (Get-ItemProperty -LiteralPath $runKey -Name $entryName -ErrorAction SilentlyContinue).$entryName
    if ($previous -and $previous -ne $startupCommand) {
        throw 'Another bridge installation owns the startup entry. Disable that installation before replacing it.'
    }
    New-Item -Path $runKey -Force | Out-Null
    New-ItemProperty -LiteralPath $runKey -Name $entryName -PropertyType String -Value $startupCommand -Force | Out-Null
    Write-Output 'Registered the hidden API entry to start at Windows sign-in.'
}
if (-not $NoStart) {
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') `
        -ArgumentList @('//B', '//Nologo', ('"' + (Join-Path $projectDir 'start-bridge.vbs') + '"')) `
        -WorkingDirectory $projectDir -WindowStyle Hidden
}
Write-Output 'Setup complete. Authorize with 01-login.cmd, then configure DSH with http://127.0.0.1:8317/v1.'
Write-Output 'Read the local API key from access.api-keys in config.yaml. Keep config.yaml and auth/ private.'
Write-Output 'Local usage dashboard: http://127.0.0.1:8317/dashboard/'
