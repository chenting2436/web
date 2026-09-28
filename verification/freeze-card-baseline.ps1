[CmdletBinding()]
param(
  [string]$ExpectedCommit = "8a754dcdb8ab97c7a90ca588693a17b21ee1f41b",
  [switch]$Refresh
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $workspaceRoot "SkyViewLab-Internal-push-worktree")).Path
$outputRoot = Join-Path $workspaceRoot "verification\acceptance\_platform\gate-a"
$manifestRoot = Join-Path $outputRoot "00-manifest"
$baselineRoot = Join-Path $outputRoot "01-legacy-baseline"
$licenseRoot = Join-Path $outputRoot "12-supply-chain-license"
$manifestPath = Join-Path $manifestRoot "baseline-manifest.json"

function Write-Utf8File {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )

  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Get-RelativeUnixPath {
  param(
    [Parameter(Mandatory = $true)][string]$BasePath,
    [Parameter(Mandatory = $true)][string]$FullPath
  )

  return [System.IO.Path]::GetRelativePath($BasePath, $FullPath).Replace("\", "/")
}

New-Item -ItemType Directory -Path $manifestRoot, $baselineRoot, $licenseRoot -Force | Out-Null

if ((Test-Path -LiteralPath $manifestPath) -and -not $Refresh) {
  throw "The Gate A baseline is already frozen. Use verification/verify-card-baseline.ps1 to verify it. Pass -Refresh only for an explicitly approved baseline replacement."
}

$approvedChecklistPath = Join-Path $baselineRoot "approved-checklist-v1.md"
$approvedChecklist = Get-Content -LiteralPath (Join-Path $workspaceRoot "CARD_VERSION_PARITY_MIGRATION_CHECKLIST.md") -Raw -Encoding UTF8
Write-Utf8File -Path $approvedChecklistPath -Content $approvedChecklist

$commit = (@(& git -C $sourceRoot rev-parse HEAD) -join "`n").Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Unable to read the legacy repository commit."
}
if ($commit -ne $ExpectedCommit) {
  throw "Legacy commit mismatch. Expected $ExpectedCommit but found $commit."
}

$worktreeChanges = @(& git -C $sourceRoot status --porcelain=v1)
if ($LASTEXITCODE -ne 0) {
  throw "Unable to inspect the legacy worktree."
}
if ($worktreeChanges.Count -gt 0) {
  throw "Legacy worktree is not clean; refuse to freeze an ambiguous baseline."
}

$trackedPaths = @(& git -C $sourceRoot -c core.quotepath=false ls-files) | Where-Object { $_ }
if ($LASTEXITCODE -ne 0 -or $trackedPaths.Count -eq 0) {
  throw "Unable to enumerate tracked legacy files."
}

$trackedEntries = foreach ($relativePath in ($trackedPaths | Sort-Object)) {
  $fullPath = Join-Path $sourceRoot ($relativePath.Replace("/", "\"))
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Tracked file is missing: $relativePath"
  }
  $fileInfo = Get-Item -LiteralPath $fullPath
  $fileHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
  [ordered]@{
    path = $relativePath.Replace("\", "/")
    bytes = $fileInfo.Length
    sha256 = $fileHash
  }
}

$routeEntries = @(
  [ordered]@{ id = "N01"; oldPath = "index.html"; reactPath = "/"; kind = "home" },
  [ordered]@{ id = "N02"; oldPath = "pages/research.html"; reactPath = "/research"; kind = "overview" },
  [ordered]@{ id = "N03"; oldPath = "pages/engineering.html"; reactPath = "/engineering"; kind = "overview" },
  [ordered]@{ id = "N04"; oldPath = "pages/teaching.html"; reactPath = "/teaching"; kind = "overview" },
  [ordered]@{ id = "N05"; oldPath = "pages/team.html"; reactPath = "/team"; kind = "core" },
  [ordered]@{ id = "N06"; oldPath = "pages/login.html"; reactPath = "/login"; kind = "core" },
  [ordered]@{ id = "N07"; oldPath = "pages/profile.html"; reactPath = "/profile"; kind = "core" },
  [ordered]@{ id = "N08"; oldPath = "pages/students.html"; reactPath = "/students"; kind = "core" },
  [ordered]@{ id = "N09"; oldPath = "pages/paid-features.html"; reactPath = "/paid-features"; kind = "core" },
  [ordered]@{ id = "N10"; oldPath = "pages/comments.html"; reactPath = "/comments"; kind = "core" },
  [ordered]@{ id = "N11"; oldPath = "pages/homework.html"; reactPath = "/homework"; kind = "core" },
  [ordered]@{ id = "T01"; oldPath = "pages/python-lab.html"; reactPath = "/python-lab"; kind = "teaching-workbench" },
  [ordered]@{ id = "T02"; oldPath = "pages/daily-practice.html"; reactPath = "/daily-practice"; kind = "teaching-workbench" },
  [ordered]@{ id = "T03"; oldPath = "pages/project-workspace.html"; reactPath = "/project-workspace"; kind = "teaching-workbench" },
  [ordered]@{ id = "T04"; oldPath = "pages/data-lab.html"; reactPath = "/data-lab"; kind = "teaching-workbench" },
  [ordered]@{ id = "T05"; oldPath = "pages/ai-report.html"; reactPath = "/ai-report"; kind = "teaching-workbench" },
  [ordered]@{ id = "T06"; oldPath = "pages/python-english.html"; reactPath = "/python-english"; kind = "teaching-workbench" },
  [ordered]@{ id = "T07"; oldPath = "pages/ai-assessment.html"; reactPath = "/ai-assessment"; kind = "teaching-workbench" },
  [ordered]@{ id = "T08"; oldPath = "pages/project-submission.html"; reactPath = "/project-submission"; kind = "teaching-workbench" },
  [ordered]@{ id = "R01"; oldPath = "pages/paper-writing.html"; reactPath = "/paper-writing"; kind = "research-workbench" },
  [ordered]@{ id = "R02"; oldPath = "pages/disaster-remote-sensing.html"; reactPath = "/disaster-remote-sensing"; kind = "research-workbench" },
  [ordered]@{ id = "R03"; oldPath = "pages/seismic-physics.html"; reactPath = "/seismic-physics"; kind = "research-workbench" },
  [ordered]@{ id = "R04"; oldPath = "pages/patent-transfer.html"; reactPath = "/patent-transfer"; kind = "research-workbench" },
  [ordered]@{ id = "R05"; oldPath = "pages/skill-evolution.html"; reactPath = "/skill-evolution"; kind = "research-workbench" },
  [ordered]@{ id = "R06"; oldPath = "pages/knowledge-system.html"; reactPath = "/knowledge-system"; kind = "research-workbench" },
  [ordered]@{ id = "R07"; oldPath = "pages/research-radar.html"; reactPath = "/research-radar"; kind = "research-workbench" },
  [ordered]@{ id = "R08"; oldPath = "pages/mine-safety-radar.html"; reactPath = "/mine-safety-radar"; kind = "research-workbench" },
  [ordered]@{ id = "R09"; oldPath = "pages/research-automation.html"; reactPath = "/research-automation"; kind = "research-workbench" },
  [ordered]@{ id = "E01"; oldPath = "pages/data-gateway.html"; reactPath = "/data-gateway"; kind = "engineering-workbench" },
  [ordered]@{ id = "E02"; oldPath = "pages/ambient-noise-imaging.html"; reactPath = "/ambient-noise-imaging"; kind = "engineering-workbench" },
  [ordered]@{ id = "E03"; oldPath = "pages/ai-patent-disclosure.html"; reactPath = "/ai-patent-disclosure"; kind = "engineering-workbench" },
  [ordered]@{ id = "X01"; oldPath = "pages/course-tools.html"; reactPath = "/teaching"; kind = "compatibility-redirect" }
)

$actualHtmlPaths = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Filter "*.html" | ForEach-Object {
  Get-RelativeUnixPath -BasePath $sourceRoot -FullPath $_.FullName
} | Sort-Object)
$declaredHtmlPaths = @($routeEntries.oldPath | Sort-Object)
$routeDifference = @(Compare-Object -ReferenceObject $actualHtmlPaths -DifferenceObject $declaredHtmlPaths)
if ($routeDifference.Count -gt 0) {
  throw "The declared route inventory does not match the legacy HTML files."
}

$workbenchCount = @($routeEntries | Where-Object { $_.kind -like "*-workbench" }).Count
if ($routeEntries.Count -ne 32 -or $workbenchCount -ne 20) {
  throw "Unexpected route/workbench count."
}

$engineeringPlaceholders = @(
  [ordered]@{ id = "G01"; name = "预警平台" },
  [ordered]@{ id = "G02"; name = "融合控制台" },
  [ordered]@{ id = "G03"; name = "决策大屏" },
  [ordered]@{ id = "G04"; name = "稳定性系数测算" },
  [ordered]@{ id = "G05"; name = "综合预警研判" },
  [ordered]@{ id = "G06"; name = "微震裂隙可视化" },
  [ordered]@{ id = "G07"; name = "无人机裂缝巡检" },
  [ordered]@{ id = "G08"; name = "点云瘦身与瓦片轻量化" },
  [ordered]@{ id = "G09"; name = "位移时间序列预测" }
)

$storageRoots = @(
  "cardVersionUsers",
  "cardVersionCurrentUser",
  "cardVersionPaidFeatures",
  "cardVersionLanguage",
  "SkyViewLabInternalCourseData",
  "skyviewCourseCache:<scope>:<moduleKey>",
  "skyviewCourseCacheMeta:<scope>:<moduleKey>",
  "cardVersionPythonWorkspaceV2",
  "cardVersionPythonLayoutV1",
  "cardVersionPythonRunHistoryV1",
  "skyviewInternalDailyPracticeV1",
  "skyviewInternalProjectWorkspaceV1",
  "skyviewInternalProjectSubmissionV1",
  "skyviewInternalDataLabV1",
  "skyviewOpenRefineProjectsV1",
  "skyviewWebLLMReportWorkspaceV1",
  "skyview2EZPythonEnglishV1",
  "skyviewJudge0AssessmentV2",
  "skyviewARSPaperWorkspaceV1",
  "skyviewResearchRemoteSensingV1",
  "skyviewResearchSeismicPhysicsV1",
  "skyviewResearchPatentTransferV1",
  "skyviewPatentTransferProV2",
  "skyviewResearchSkillEvolutionV1",
  "skyviewSkillEvolutionProV2",
  "SkyViewLabKnowledgeSystem",
  "skyviewResearchRadarV1",
  "skyviewMineSafetyRadarV1",
  "skyviewResearchAutomationV1",
  "skyviewInternalNiFiDataFlowV2",
  "skyviewInternalAmbientNoiseImagingV1",
  "skyviewPatentAssistantV1",
  "skyviewInternalCommentsV1",
  "skyviewInternalHomeworkV1"
)

$schemaPattern = 'schema\s*:\s*["''](?<id>skyview[^"'']+)["'']'
$schemaOccurrences = foreach ($scriptFile in (Get-ChildItem -LiteralPath (Join-Path $sourceRoot "assets\scripts") -Recurse -File -Filter "*.js")) {
  $relativeScriptPath = Get-RelativeUnixPath -BasePath $sourceRoot -FullPath $scriptFile.FullName
  $lineNumber = 0
  foreach ($line in (Get-Content -LiteralPath $scriptFile.FullName -Encoding UTF8)) {
    $lineNumber += 1
    foreach ($match in [regex]::Matches($line, $schemaPattern)) {
      [ordered]@{
        identifier = $match.Groups["id"].Value
        source = $relativeScriptPath
        line = $lineNumber
      }
    }
  }
}
$schemaOccurrences = @($schemaOccurrences | Sort-Object identifier, source, line)

$assetPattern = '(?<attribute>src|href)\s*=\s*["''](?<value>[^"'']+)["'']'
$pageAssets = foreach ($routeEntry in $routeEntries) {
  $pageFullPath = Join-Path $sourceRoot ($routeEntry.oldPath.Replace("/", "\"))
  $pageDirectory = Split-Path -Parent $pageFullPath
  $pageText = Get-Content -LiteralPath $pageFullPath -Raw -Encoding UTF8
  $assets = foreach ($match in [regex]::Matches($pageText, $assetPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
    $rawValue = $match.Groups["value"].Value
    if ($rawValue -match '^(?:https?:|data:|javascript:|#)') {
      [ordered]@{
        attribute = $match.Groups["attribute"].Value.ToLowerInvariant()
        reference = $rawValue
        external = $true
        exists = $null
      }
      continue
    }
    $pathOnly = ($rawValue -split '[?#]', 2)[0]
    $assetFullPath = [System.IO.Path]::GetFullPath((Join-Path $pageDirectory $pathOnly))
    [ordered]@{
      attribute = $match.Groups["attribute"].Value.ToLowerInvariant()
      reference = $rawValue
      external = $false
      path = Get-RelativeUnixPath -BasePath $sourceRoot -FullPath $assetFullPath
      exists = Test-Path -LiteralPath $assetFullPath -PathType Leaf
    }
  }
  [ordered]@{
    id = $routeEntry.id
    oldPath = $routeEntry.oldPath
    assets = @($assets)
  }
}

$testFiles = @($trackedPaths | Where-Object { $_ -like "tests/*" } | Sort-Object)

$trackedManifestPath = Join-Path $baselineRoot "tracked-files.sha256"
$trackedManifestText = (($trackedEntries | ForEach-Object { "$($_.sha256)  $($_.path)" }) -join "`n") + "`n"
Write-Utf8File -Path $trackedManifestPath -Content $trackedManifestText
Write-Utf8File -Path (Join-Path $baselineRoot "routes.json") -Content (($routeEntries | ConvertTo-Json -Depth 6) + "`n")
Write-Utf8File -Path (Join-Path $baselineRoot "engineering-placeholders.json") -Content (($engineeringPlaceholders | ConvertTo-Json -Depth 4) + "`n")
Write-Utf8File -Path (Join-Path $baselineRoot "storage-roots.json") -Content (($storageRoots | ConvertTo-Json -Depth 3) + "`n")
Write-Utf8File -Path (Join-Path $baselineRoot "schema-occurrences.json") -Content (($schemaOccurrences | ConvertTo-Json -Depth 5) + "`n")
Write-Utf8File -Path (Join-Path $baselineRoot "page-assets.json") -Content (($pageAssets | ConvertTo-Json -Depth 8) + "`n")
Write-Utf8File -Path (Join-Path $baselineRoot "test-files.json") -Content (($testFiles | ConvertTo-Json -Depth 3) + "`n")

Push-Location $sourceRoot
try {
  $testLines = @(& node --test 2>&1)
  $testExitCode = $LASTEXITCODE
}
finally {
  Pop-Location
}
$testText = ($testLines -join "`n") + "`n"
Write-Utf8File -Path (Join-Path $baselineRoot "legacy-tests.tap") -Content $testText

$testCount = 0
$passCount = 0
$failCount = 0
if ($testText -match '(?m)^[^\r\n]*tests\s+(\d+)\s*$') { $testCount = [int]$Matches[1] }
if ($testText -match '(?m)^[^\r\n]*pass\s+(\d+)\s*$') { $passCount = [int]$Matches[1] }
if ($testText -match '(?m)^[^\r\n]*fail\s+(\d+)\s*$') { $failCount = [int]$Matches[1] }
if ($testExitCode -ne 0 -or $testCount -ne 109 -or $passCount -ne 109 -or $failCount -ne 0) {
  throw "Legacy test baseline failed or changed: exit=$testExitCode tests=$testCount pass=$passCount fail=$failCount"
}
$testSummary = [ordered]@{
  command = "node --test"
  exitCode = $testExitCode
  tests = $testCount
  passed = $passCount
  failed = $failCount
}
Write-Utf8File -Path (Join-Path $baselineRoot "legacy-test-summary.json") -Content (($testSummary | ConvertTo-Json -Depth 4) + "`n")

$sourceDocuments = @(
  $approvedChecklistPath,
  (Join-Path $workspaceRoot "PRODUCTION_REBUILD_BLUEPRINT.md"),
  (Join-Path $workspaceRoot "PRODUCTION_GAP_AUDIT.md"),
  (Join-Path $workspaceRoot "OSS_REFERENCE_REGISTER.md"),
  (Join-Path $workspaceRoot "MIGRATION_MATRIX.md"),
  "D:\softwaredata\weixindata\xwechat_files\wxid_u841bd6qj0ou22_4467\msg\file\2026-09\BACKEND-REQUIREMENTS.md",
  "D:\softwaredata\weixindata\xwechat_files\wxid_u841bd6qj0ou22_4467\msg\file\2026-09\GITHUB-OPEN-SOURCE-MAPPING.md"
)
$sourceDocumentEntries = foreach ($documentPath in $sourceDocuments) {
  if (-not (Test-Path -LiteralPath $documentPath -PathType Leaf)) {
    throw "Required source document is missing: $documentPath"
  }
  $documentInfo = Get-Item -LiteralPath $documentPath
  [ordered]@{
    path = $documentInfo.FullName
    bytes = $documentInfo.Length
    sha256 = (Get-FileHash -LiteralPath $documentInfo.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
Write-Utf8File -Path (Join-Path $licenseRoot "source-documents.json") -Content (($sourceDocumentEntries | ConvertTo-Json -Depth 4) + "`n")

$artifactPaths = @(
  (Join-Path $baselineRoot "tracked-files.sha256"),
  (Join-Path $baselineRoot "routes.json"),
  (Join-Path $baselineRoot "engineering-placeholders.json"),
  (Join-Path $baselineRoot "storage-roots.json"),
  (Join-Path $baselineRoot "schema-occurrences.json"),
  (Join-Path $baselineRoot "page-assets.json"),
  (Join-Path $baselineRoot "test-files.json"),
  $approvedChecklistPath,
  (Join-Path $baselineRoot "FUNCTION_TRACEABILITY.md"),
  (Join-Path $baselineRoot "legacy-tests.tap"),
  (Join-Path $baselineRoot "legacy-test-summary.json"),
  (Join-Path $licenseRoot "source-documents.json")
)
$artifactEntries = foreach ($artifactPath in $artifactPaths) {
  [ordered]@{
    path = Get-RelativeUnixPath -BasePath $outputRoot -FullPath $artifactPath
    sha256 = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

$baselineManifest = [ordered]@{
  schema = "skyview-card-version-baseline"
  schemaVersion = 1
  generatedAt = [DateTime]::UtcNow.ToString("o")
  source = [ordered]@{
    path = $sourceRoot
    commit = $commit
    clean = $true
    trackedFiles = $trackedEntries.Count
  }
  counts = [ordered]@{
    htmlEntries = $routeEntries.Count
    formalEntries = @($routeEntries | Where-Object { $_.kind -ne "compatibility-redirect" }).Count
    workbenches = $workbenchCount
    teachingWorkbenches = @($routeEntries | Where-Object { $_.kind -eq "teaching-workbench" }).Count
    researchWorkbenches = @($routeEntries | Where-Object { $_.kind -eq "research-workbench" }).Count
    engineeringWorkbenches = @($routeEntries | Where-Object { $_.kind -eq "engineering-workbench" }).Count
    engineeringPlaceholders = $engineeringPlaceholders.Count
    storageRoots = $storageRoots.Count
    schemaOccurrences = $schemaOccurrences.Count
  }
  legacyTests = $testSummary
  artifacts = $artifactEntries
}
Write-Utf8File -Path $manifestPath -Content (($baselineManifest | ConvertTo-Json -Depth 8) + "`n")

Write-Output "Gate A legacy baseline frozen."
Write-Output "Commit: $commit"
Write-Output "Tracked files: $($trackedEntries.Count)"
Write-Output "HTML entries: $($routeEntries.Count)"
Write-Output "Real workbenches: $workbenchCount"
Write-Output "Engineering placeholders: $($engineeringPlaceholders.Count)"
Write-Output "Legacy tests: $passCount/$testCount passed"
Write-Output "Manifest: $manifestPath"
