[CmdletBinding()]
param(
    [string]$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DemoAccount = $env:SKYVIEW_LOCAL_DEMO_ACCOUNT,
    [string]$DemoPassword = $env:SKYVIEW_LOCAL_DEMO_PASSWORD,
    [string]$StudentAccount = $env:SKYVIEW_LOCAL_STUDENT_ACCOUNT,
    [string]$StudentPassword = $env:SKYVIEW_LOCAL_STUDENT_PASSWORD
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$localCredentialFile = Join-Path $WorkspaceRoot '.env.backend'
if (([string]::IsNullOrWhiteSpace($DemoAccount) -or [string]::IsNullOrWhiteSpace($DemoPassword)) -and
    (Test-Path -LiteralPath $localCredentialFile)) {
    foreach ($line in Get-Content -LiteralPath $localCredentialFile) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#') -or -not $line.Contains('=')) {
            continue
        }
        $parts = $line.Split('=', 2)
        $key = $parts[0].Trim()
        $value = $parts[1]
        switch ($key) {
            'SKYVIEW_LOCAL_DEMO_ACCOUNT' { if (-not $DemoAccount) { $DemoAccount = $value } }
            'SKYVIEW_LOCAL_DEMO_PASSWORD' { if (-not $DemoPassword) { $DemoPassword = $value } }
            'SKYVIEW_LOCAL_STUDENT_ACCOUNT' { if (-not $StudentAccount) { $StudentAccount = $value } }
            'SKYVIEW_LOCAL_STUDENT_PASSWORD' { if (-not $StudentPassword) { $StudentPassword = $value } }
        }
    }
}

if ([string]::IsNullOrWhiteSpace($DemoAccount) -or [string]::IsNullOrWhiteSpace($DemoPassword)) {
    throw 'Set local demo credentials through the environment or the ignored .env.backend file before restarting local services.'
}
if (($StudentAccount -and -not $StudentPassword) -or ($StudentPassword -and -not $StudentAccount)) {
    throw 'Set both local student account variables or leave both empty.'
}

$workspace = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$pythonRoot = (Resolve-Path -LiteralPath (Join-Path $workspace 'backend_python')).Path
$goRoot = (Resolve-Path -LiteralPath (Join-Path $workspace 'backend_go')).Path
$pythonExe = Join-Path $pythonRoot '.venv\Scripts\python.exe'
$binRoot = Join-Path $goRoot 'bin'
$apiExe = Join-Path $binRoot 'skyviewlab-api.exe'
$workerExe = Join-Path $binRoot 'skyviewlab-worker.exe'
$apiExecutables = @($apiExe) + @(
    Get-ChildItem -LiteralPath $binRoot -File -Filter 'skyviewlab-api*.exe' -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
)
$workerExecutables = @($workerExe) + @(
    Get-ChildItem -LiteralPath $binRoot -File -Filter 'skyviewlab-worker*.exe' -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
)

function Stop-WorkspaceListener {
    param([int]$Port, [string[]]$AllowedExecutables, [string[]]$AllowedCommandPrefixes = @())

    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.ExecutablePath)) {
            throw "Cannot resolve the process listening on port $Port."
        }
        $actual = [System.IO.Path]::GetFullPath($process.ExecutablePath)
        $allowed = $AllowedExecutables | Where-Object {
            $actual.Equals([System.IO.Path]::GetFullPath($_), [System.StringComparison]::OrdinalIgnoreCase)
        }
        if (-not $allowed -and $process.CommandLine) {
            $allowed = $AllowedCommandPrefixes | Where-Object {
                $process.CommandLine.StartsWith("`"$_`"", [System.StringComparison]::OrdinalIgnoreCase)
            }
        }
        if (-not $allowed) {
            throw "Port $Port is owned by a process outside the SkyViewLab workspace."
        }
        Stop-Process -Id $listener.OwningProcess -Force
        if ($process.ParentProcessId -and (Get-Process -Id $process.ParentProcessId -ErrorAction SilentlyContinue)) {
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ParentProcessId)"
            if ($null -ne $parent -and $parent.ExecutablePath -and
                ([System.IO.Path]::GetFullPath($parent.ExecutablePath)).Equals($actual, [System.StringComparison]::OrdinalIgnoreCase)) {
                Stop-Process -Id $process.ParentProcessId -Force
            }
        }
    }
}

Stop-WorkspaceListener -Port 8000 -AllowedExecutables @($pythonExe) -AllowedCommandPrefixes @($pythonExe)
Stop-WorkspaceListener -Port 8080 -AllowedExecutables $apiExecutables
Get-CimInstance Win32_Process | Where-Object {
    if (-not $_.ExecutablePath) { return $false }
    $actual = [System.IO.Path]::GetFullPath($_.ExecutablePath)
    return $null -ne ($workerExecutables | Where-Object {
        $actual.Equals([System.IO.Path]::GetFullPath($_), [System.StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1)
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$deadline = [DateTime]::UtcNow.AddSeconds(8)
do {
    $occupied = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 8000, 8080 })
    if (-not $occupied) { break }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
if ($occupied) { throw 'Backend ports did not close cleanly.' }

$pythonCommand = Get-Command python -ErrorAction Stop
$goCommand = Get-Command go -ErrorAction Stop
if (-not (Test-Path -LiteralPath $pythonExe)) {
    & $pythonCommand.Source -m venv (Join-Path $pythonRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the Python virtual environment.' }
}
$pythonExe = (Resolve-Path -LiteralPath $pythonExe).Path
& $pythonExe -m pip install --disable-pip-version-check -r (Join-Path $pythonRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Failed to install Python runtime dependencies.' }

New-Item -ItemType Directory -Path $binRoot -Force | Out-Null
Push-Location $goRoot
try {
    & $goCommand.Source build -o $apiExe ./cmd/server
    if ($LASTEXITCODE -ne 0) { throw 'Failed to build the Go API.' }
    & $goCommand.Source build -o $workerExe ./cmd/worker
    if ($LASTEXITCODE -ne 0) { throw 'Failed to build the Go worker.' }
}
finally {
    Pop-Location
}

$serviceSecret = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
$workerToken = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
$workerCapabilities = & node (Join-Path $workspace 'verification\build-dev-worker-capabilities.mjs')
if ([string]::IsNullOrWhiteSpace($workerCapabilities)) { throw 'Worker capability generation failed.' }

$env:APP_ENV = 'development'
$env:PYTHON_HOST = '127.0.0.1'
$env:PYTHON_PORT = '8000'
$env:CORS_ORIGINS = 'http://localhost:4182,http://127.0.0.1:4182'
$env:TRUSTED_SERVICE_ID = 'go-control-plane'
$env:SERVICE_HMAC_SECRET = $serviceSecret
$env:ALLOW_UNSIGNED_DEV_REQUESTS = 'false'
$env:ALLOW_UNSAFE_LOCAL_CODE_EXECUTION = 'false'
$env:MAX_REQUEST_BYTES = '1048576'
$pythonProcess = Start-Process -FilePath $pythonExe -ArgumentList '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000' -WorkingDirectory $pythonRoot -RedirectStandardOutput (Join-Path $pythonRoot 'python-live.out.log') -RedirectStandardError (Join-Path $pythonRoot 'python-live.err.log') -WindowStyle Hidden -PassThru

$env:GO_API_ADDRESS = '127.0.0.1:8080'
$env:PYTHON_SERVICE_URL = 'http://127.0.0.1:8000'
$env:PYTHON_ALLOW_INSECURE_HTTP = 'true'
$env:PYTHON_REQUEST_TIMEOUT = '450s'
$env:JOB_TERMINAL_PERSIST_TIMEOUT = '120s'
$env:PYTHON_SERVICE_ID = 'go-control-plane'
$env:DEV_MODE = 'true'
$env:DEV_AUTHORIZATION_FALLBACK = 'true'
$env:DEV_TENANT_ID = 'tenant-local'
$env:DEV_WORKSPACE_ID = 'workspace-local'
$env:DATABASE_ADAPTER = 'sqlite-development'
$env:DATABASE_FILE = (Join-Path $goRoot 'data\skyviewlab.db')
$env:DATABASE_URL = ''
$env:DATABASE_MIGRATE = 'false'
$env:DEMO_ACCOUNT = $DemoAccount
$env:DEMO_PASSWORD = $DemoPassword
$env:STUDENT_ACCOUNT = $StudentAccount
$env:STUDENT_PASSWORD = $StudentPassword
$env:COOKIE_SECURE = 'false'
$env:WORKER_ID = 'local-worker-1'
$env:WORKER_TOKEN = $workerToken
$env:WORKER_CAPABILITIES_JSON = $workerCapabilities
$apiProcess = Start-Process -FilePath $apiExe -WorkingDirectory $goRoot -RedirectStandardOutput (Join-Path $goRoot 'go-live.out.log') -RedirectStandardError (Join-Path $goRoot 'go-live.err.log') -WindowStyle Hidden -PassThru

Remove-Item Env:SERVICE_HMAC_SECRET -ErrorAction SilentlyContinue
Remove-Item Env:WORKER_CAPABILITIES_JSON -ErrorAction SilentlyContinue
$env:GO_CONTROL_PLANE_URL = 'http://127.0.0.1:8080'
$workerProcess = Start-Process -FilePath $workerExe -WorkingDirectory $goRoot -RedirectStandardOutput (Join-Path $goRoot 'worker-live.out.log') -RedirectStandardError (Join-Path $goRoot 'worker-live.err.log') -WindowStyle Hidden -PassThru

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Milliseconds 400
    try {
        $goReadiness = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/v1/ready' -TimeoutSec 2
        $pythonReadiness = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/ready' -TimeoutSec 2
        if ($goReadiness.data.status -eq 'ready' -and $pythonReadiness.data.status -eq 'ready') {
            $ready = $true
            break
        }
    }
    catch {}
}
if (-not $ready) { throw 'Backend services did not become ready.' }

[pscustomobject]@{
    apiPid = $apiProcess.Id
    workerPid = $workerProcess.Id
    pythonPid = $pythonProcess.Id
    go = $goReadiness.data.status
    python = $pythonReadiness.data.status
} | ConvertTo-Json -Compress
