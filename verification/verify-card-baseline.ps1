[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $workspaceRoot "SkyViewLab-Internal-push-worktree")).Path
$outputRoot = Join-Path $workspaceRoot "verification\acceptance\_platform\gate-a"
$manifestPath = Join-Path $outputRoot "00-manifest\baseline-manifest.json"

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Gate A baseline manifest is missing."
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schema -ne "skyview-card-version-baseline" -or [int]$manifest.schemaVersion -ne 1) {
  throw "Unsupported Gate A baseline manifest."
}

$commit = (@(& git -C $sourceRoot rev-parse HEAD) -join "`n").Trim()
if ($LASTEXITCODE -ne 0 -or $commit -ne $manifest.source.commit) {
  throw "Legacy repository commit no longer matches the frozen baseline."
}
$worktreeChanges = @(& git -C $sourceRoot status --porcelain=v1)
if ($LASTEXITCODE -ne 0 -or $worktreeChanges.Count -gt 0) {
  throw "Legacy repository is not clean."
}

foreach ($artifact in $manifest.artifacts) {
  $artifactPath = Join-Path $outputRoot ($artifact.path.Replace("/", "\"))
  if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
    throw "Frozen artifact is missing: $($artifact.path)"
  }
  $actualHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $artifact.sha256) {
    throw "Frozen artifact hash mismatch: $($artifact.path)"
  }
}

$trackedManifestPath = Join-Path $outputRoot "01-legacy-baseline\tracked-files.sha256"
$trackedLines = @(Get-Content -LiteralPath $trackedManifestPath -Encoding UTF8 | Where-Object { $_ })
if ($trackedLines.Count -ne [int]$manifest.source.trackedFiles) {
  throw "Tracked file count no longer matches the frozen manifest."
}
foreach ($line in $trackedLines) {
  if ($line -notmatch '^([0-9a-f]{64})  (.+)$') {
    throw "Invalid tracked file hash line: $line"
  }
  $expectedHash = $Matches[1]
  $relativePath = $Matches[2]
  $fullPath = Join-Path $sourceRoot ($relativePath.Replace("/", "\"))
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Legacy tracked file is missing: $relativePath"
  }
  $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    throw "Legacy tracked file hash mismatch: $relativePath"
  }
}

$routes = @(Get-Content -LiteralPath (Join-Path $outputRoot "01-legacy-baseline\routes.json") -Raw -Encoding UTF8 | ConvertFrom-Json)
$placeholders = @(Get-Content -LiteralPath (Join-Path $outputRoot "01-legacy-baseline\engineering-placeholders.json") -Raw -Encoding UTF8 | ConvertFrom-Json)
$testSummary = Get-Content -LiteralPath (Join-Path $outputRoot "01-legacy-baseline\legacy-test-summary.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($routes.Count -ne 32 -or @($routes | Where-Object { $_.kind -like "*-workbench" }).Count -ne 20) {
  throw "Frozen route inventory count is invalid."
}
if ($placeholders.Count -ne 9) {
  throw "Frozen engineering placeholder count is invalid."
}
if ([int]$testSummary.tests -ne 109 -or [int]$testSummary.passed -ne 109 -or [int]$testSummary.failed -ne 0) {
  throw "Frozen legacy test summary is invalid."
}

$sourceDocuments = @(Get-Content -LiteralPath (Join-Path $outputRoot "12-supply-chain-license\source-documents.json") -Raw -Encoding UTF8 | ConvertFrom-Json)
foreach ($document in $sourceDocuments) {
  if (-not (Test-Path -LiteralPath $document.path -PathType Leaf)) {
    throw "Frozen source document is missing: $($document.path)"
  }
  $actualHash = (Get-FileHash -LiteralPath $document.path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $document.sha256) {
    throw "Frozen source document hash mismatch: $($document.path)"
  }
}

Write-Output "Gate A baseline verification passed."
Write-Output "Commit: $commit"
Write-Output "Tracked files: $($trackedLines.Count)"
Write-Output "HTML entries: $($routes.Count)"
Write-Output "Real workbenches: $(@($routes | Where-Object { $_.kind -like '*-workbench' }).Count)"
Write-Output "Engineering placeholders: $($placeholders.Count)"
Write-Output "Legacy tests: $($testSummary.passed)/$($testSummary.tests) passed"
