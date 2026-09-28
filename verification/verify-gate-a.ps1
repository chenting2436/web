[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $workspaceRoot "SkyViewLab-Internal-push-worktree")).Path

& (Join-Path $PSScriptRoot "verify-card-baseline.ps1")
if ($LASTEXITCODE -ne 0) {
  throw "Frozen card baseline verification failed."
}

Push-Location $sourceRoot
try {
  $testLines = @(& node --test 2>&1)
  $testExitCode = $LASTEXITCODE
}
finally {
  Pop-Location
}
$testText = $testLines -join [Environment]::NewLine
$testCount = 0
$passCount = 0
$failCount = 0
if ($testText -match '(?m)^[^\r\n]*tests\s+(\d+)\s*$') { $testCount = [int]$Matches[1] }
if ($testText -match '(?m)^[^\r\n]*pass\s+(\d+)\s*$') { $passCount = [int]$Matches[1] }
if ($testText -match '(?m)^[^\r\n]*fail\s+(\d+)\s*$') { $failCount = [int]$Matches[1] }
if ($testExitCode -ne 0 -or $testCount -ne 109 -or $passCount -ne 109 -or $failCount -ne 0) {
  throw "Live legacy regression failed: exit=$testExitCode tests=$testCount pass=$passCount fail=$failCount"
}

Push-Location $workspaceRoot
try {
  & node "verification\validate-gate-a.mjs"
  if ($LASTEXITCODE -ne 0) {
    throw "Gate A deliverable validation failed."
  }
}
finally {
  Pop-Location
}

Write-Output "Gate A integrated verification passed."
Write-Output "Live legacy regression: $passCount/$testCount passed"
Write-Output "Release status remains NO-GO until all open Gate A decisions and later gates are closed."
