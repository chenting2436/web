[CmdletBinding()]
param(
    [string]$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workspace = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$webRoot = (Resolve-Path -LiteralPath (Join-Path $workspace 'web_react')).Path
$goBinRoot = [System.IO.Path]::GetFullPath((Join-Path $workspace 'backend_go\bin'))
$pythonExe = [System.IO.Path]::GetFullPath((Join-Path $workspace 'backend_python\.venv\Scripts\python.exe'))
$stopped = [System.Collections.Generic.HashSet[int]]::new()

function Stop-CheckedListener {
    param(
        [int]$Port,
        [scriptblock]$IsOwned
    )

    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        if ($null -eq $process -or -not (& $IsOwned $process)) {
            throw "Port $Port is owned by a process outside this SkyViewLab checkout."
        }
        Stop-Process -Id $listener.OwningProcess -Force
        $null = $stopped.Add([int]$listener.OwningProcess)
    }
}

Stop-CheckedListener -Port 4182 -IsOwned {
    param($process)
    return $process.CommandLine -and
        $process.CommandLine.Contains($webRoot, [System.StringComparison]::OrdinalIgnoreCase)
}
Stop-CheckedListener -Port 8080 -IsOwned {
    param($process)
    if (-not $process.ExecutablePath) { return $false }
    $path = [System.IO.Path]::GetFullPath($process.ExecutablePath)
    return $path.StartsWith("$goBinRoot\", [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($path).StartsWith('skyviewlab-api', [System.StringComparison]::OrdinalIgnoreCase)
}
Stop-CheckedListener -Port 8000 -IsOwned {
    param($process)
    $executableMatches = $process.ExecutablePath -and
        ([System.IO.Path]::GetFullPath($process.ExecutablePath)).Equals(
            $pythonExe,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    $commandMatches = $process.CommandLine -and
        $process.CommandLine.StartsWith("`"$pythonExe`"", [System.StringComparison]::OrdinalIgnoreCase)
    return $executableMatches -or $commandMatches
}

Get-CimInstance Win32_Process | Where-Object {
    if (-not $_.ExecutablePath) { return $false }
    $path = [System.IO.Path]::GetFullPath($_.ExecutablePath)
    return $path.StartsWith("$goBinRoot\", [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($path).StartsWith('skyviewlab-worker', [System.StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    $null = $stopped.Add([int]$_.ProcessId)
}

[pscustomobject]@{
    status = 'stopped'
    processIds = @($stopped)
} | ConvertTo-Json -Compress
