[CmdletBinding()]
param(
    [string]$GoBaseUrl = 'http://127.0.0.1:8080/api/v1',
    [string]$PythonBaseUrl = 'http://127.0.0.1:8000',
    [string]$WebBaseUrl = 'http://localhost:4182'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function Get-HttpFailureStatus {
    param([scriptblock]$Request)
    try {
        & $Request | Out-Null
        return 200
    }
    catch {
        if ($null -eq $_.Exception.Response) {
            throw
        }
        return [int]$_.Exception.Response.StatusCode
    }
}

$goReadiness = Invoke-RestMethod -Method Get -Uri "$GoBaseUrl/ready"
$pythonReadiness = Invoke-RestMethod -Method Get -Uri "$PythonBaseUrl/ready"
$catalogResponse = Invoke-WebRequest -UseBasicParsing -Method Get -Uri "$GoBaseUrl/tools/catalog" -Headers @{ Origin = $WebBaseUrl }
$catalog = $catalogResponse.Content | ConvertFrom-Json
$landingResponse = Invoke-WebRequest -UseBasicParsing -Method Get -Uri "$WebBaseUrl/"
$authCompleteResponse = Invoke-WebRequest -UseBasicParsing -Method Get -Uri "$WebBaseUrl/auth/complete"
$homeworkResponse = Invoke-WebRequest -UseBasicParsing -Method Get -Uri "$WebBaseUrl/homework"

Assert-True ($goReadiness.data.status -eq 'ready') 'Go control plane is not ready.'
Assert-True ($pythonReadiness.data.status -eq 'ready') 'Python compute plane is not ready.'
Assert-True ($landingResponse.StatusCode -eq 200) 'React landing page did not return HTTP 200.'
Assert-True ($authCompleteResponse.StatusCode -eq 200) 'React OIDC completion page did not return HTTP 200.'
Assert-True ($homeworkResponse.StatusCode -eq 200) 'React homework gate did not return HTTP 200.'
$homeworkGateLabel = -join @([char]0x5B89, [char]0x5168, [char]0x6574, [char]0x6539, [char]0x4E2D)
Assert-True ($homeworkResponse.Content.Contains($homeworkGateLabel)) 'Homework security gate is not visible.'
Assert-True (@($catalog.data).Count -eq 26) 'The capability catalog does not contain 26 frozen entries.'
Assert-True (-not (@($catalog.data) | Where-Object { $_.productionReady -eq $true })) 'A capability was incorrectly marked production-ready.'
Assert-True ($catalogResponse.Headers['Access-Control-Allow-Origin'] -contains $WebBaseUrl) 'The configured React origin is not allowed by Go.'

$unsignedPythonStatus = Get-HttpFailureStatus {
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$PythonBaseUrl/tools/paper-writing/run" -ContentType 'application/json' -Body '{"action":"audit","payload":{}}'
}
$anonymousJobStatus = Get-HttpFailureStatus {
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$GoBaseUrl/projects/not-authorized/jobs" -ContentType 'application/json' -Body '{"slug":"paper-writing","action":"audit","input":{},"idempotencyKey":"smoke-check"}'
}

Assert-True ($unsignedPythonStatus -eq 401) 'Unsigned direct Python execution was not rejected with HTTP 401.'
Assert-True ($anonymousJobStatus -eq 401) 'Anonymous Go job creation was not rejected with HTTP 401.'

[pscustomobject]@{
    status = 'passed'
    go = $goReadiness.data.status
    python = $pythonReadiness.data.status
    react = $landingResponse.StatusCode
    oidcCompletion = $authCompleteResponse.StatusCode
    capabilities = @($catalog.data).Count
    unsignedPython = $unsignedPythonStatus
    anonymousJob = $anonymousJobStatus
} | ConvertTo-Json -Compress
