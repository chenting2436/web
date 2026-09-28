[CmdletBinding()]
param(
    [string]$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DemoAccount = $env:SKYVIEW_LOCAL_DEMO_ACCOUNT,
    [string]$DemoPassword = $env:SKYVIEW_LOCAL_DEMO_PASSWORD,
    [string]$StudentAccount = $env:SKYVIEW_LOCAL_STUDENT_ACCOUNT,
    [string]$StudentPassword = $env:SKYVIEW_LOCAL_STUDENT_PASSWORD,
    [switch]$OpenBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workspace = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$webRoot = (Resolve-Path -LiteralPath (Join-Path $workspace 'web_react')).Path
$packageLock = Join-Path $webRoot 'package-lock.json'
$nodeModules = Join-Path $webRoot 'node_modules'
$dependencyMarker = Join-Path $nodeModules '.skyviewlab-package-lock.sha256'

$nodeCommand = Get-Command node -ErrorAction Stop
$npmCommand = Get-Command npm.cmd -ErrorAction Stop
$nodeVersion = (& $nodeCommand.Source --version).TrimStart('v')
if ([version]$nodeVersion -lt [version]'22.13.0') {
    throw "Node.js 22.13.0 or newer is required; found $nodeVersion."
}

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 4182 -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    if ($null -eq $process -or -not $process.CommandLine -or
        -not $process.CommandLine.Contains($webRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Port 4182 is owned by a process outside this SkyViewLab checkout.'
    }
    Stop-Process -Id $listener.OwningProcess -Force
}

$lockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $packageLock).Hash
$installedHash = if (Test-Path -LiteralPath $dependencyMarker) {
    (Get-Content -LiteralPath $dependencyMarker -Raw).Trim()
}
else {
    ''
}
if (-not (Test-Path -LiteralPath $nodeModules) -or $installedHash -ne $lockHash) {
    Push-Location $webRoot
    try {
        & $npmCommand.Source ci
        if ($LASTEXITCODE -ne 0) { throw 'Failed to install React dependencies.' }
        [System.IO.File]::WriteAllText($dependencyMarker, "$lockHash`n")
    }
    finally {
        Pop-Location
    }
}

[array]$backendOutput = & (Join-Path $PSScriptRoot 'restart-local-services.ps1') `
    -WorkspaceRoot $workspace `
    -DemoAccount $DemoAccount `
    -DemoPassword $DemoPassword `
    -StudentAccount $StudentAccount `
    -StudentPassword $StudentPassword
if ($LASTEXITCODE -ne 0) { throw 'Backend startup failed.' }

$env:NEXT_PUBLIC_API_BASE_URL = 'http://localhost:8080/api/v1'
$env:NEXT_PUBLIC_OIDC_ENABLED = 'false'
$env:NEXT_PUBLIC_ENABLE_DEV_LOGIN = 'true'
$webProcess = Start-Process -FilePath $npmCommand.Source `
    -ArgumentList 'run', 'dev', '--', '--host', 'localhost', '--port', '4182' `
    -WorkingDirectory $webRoot `
    -RedirectStandardOutput (Join-Path $webRoot 'react-live.out.log') `
    -RedirectStandardError (Join-Path $webRoot 'react-live.err.log') `
    -WindowStyle Hidden `
    -PassThru
Remove-Item Env:NEXT_PUBLIC_API_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:NEXT_PUBLIC_OIDC_ENABLED -ErrorAction SilentlyContinue
Remove-Item Env:NEXT_PUBLIC_ENABLE_DEV_LOGIN -ErrorAction SilentlyContinue

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:4182/' -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            $ready = $true
            break
        }
    }
    catch {}
}
if (-not $ready) {
    Get-Content -LiteralPath (Join-Path $webRoot 'react-live.err.log') -Tail 50 -ErrorAction SilentlyContinue
    throw 'React service did not become ready.'
}

[array]$verification = & (Join-Path $PSScriptRoot 'verify-local.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Local integration verification failed.' }

if ($OpenBrowser) {
    Start-Process 'http://localhost:4182/'
}

[pscustomobject]@{
    status = 'ready'
    url = 'http://localhost:4182/'
    webHostPid = $webProcess.Id
    backend = $backendOutput[-1]
    verification = $verification[-1]
} | ConvertTo-Json -Compress
