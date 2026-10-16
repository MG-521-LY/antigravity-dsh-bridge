param([int]$BackendPid, [int]$ParentPid, [string]$InstallDir)
$ErrorActionPreference = 'Stop'
if ($BackendPid -le 0 -or $ParentPid -le 0) { exit 1 }
$candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $BackendPid)
if (-not $candidate) { exit 0 }
$expected = Join-Path ([IO.Path]::GetFullPath($InstallDir)) 'bin\cli-proxy-api.exe'
if ($candidate.ParentProcessId -ne $ParentPid -or $candidate.ExecutablePath -ne $expected -or
    -not $candidate.CommandLine -or $candidate.CommandLine.IndexOf((Join-Path $InstallDir 'config.backend.yaml'), [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw 'Refused to stop an unrecognized backend process.'
}
Stop-Process -Id $BackendPid -ErrorAction Stop
