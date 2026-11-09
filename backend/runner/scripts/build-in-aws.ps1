# Builds the runner image in AWS (CodeBuild) from a branch on GitHub and pushes it to the runner's ECR repository,
# so nothing uploads from this machine. Then it reads the digest from ECR, checks the image exists and writes
# .aws-sam/deploy-template.yaml, exactly like push-image.ps1 does.
#
#   powershell -File scripts\build-in-aws.ps1 [-Branch feature/cpp-runner] [-Environment dev]
#
# Needs the build stack (backend\runner\build) deployed and the branch pushed to GitHub: CodeBuild builds what is on
# GitHub, not what is on this machine.
param(
  [string]$Branch = 'feature/cpp-runner',
  [string]$Environment = 'dev',
  [string]$Region = 'us-east-1',
  [int]$TimeoutMinutes = 25
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\native.ps1"
. "$PSScriptRoot\deploy-template.ps1"

$project = "micro-credentialing-runner-build-$Environment"
$repoName = "micro-credentialing-runner-$Environment"

# CodeBuild builds the pushed branch. Warn when this checkout differs from it.
$remote = Invoke-Native { git ls-remote origin "refs/heads/$Branch" }
if ($remote.Code -ne 0 -or -not $remote.Stdout) { throw "Branch $Branch is not on GitHub. Push it first: git push origin $Branch" }
$remoteSha = ($remote.Stdout -split '\s+')[0]
$local = Invoke-Native { git rev-parse HEAD }
$branchHere = Invoke-Native { git rev-parse --abbrev-ref HEAD }
if ($branchHere.Stdout -eq $Branch -and $local.Stdout -ne $remoteSha) {
  Write-Warning "Local HEAD ($($local.Stdout.Substring(0,12))) differs from GitHub $Branch ($($remoteSha.Substring(0,12))). CodeBuild builds the GitHub one."
}
$dirty = Invoke-Native { git status --porcelain -- . }
if ($dirty.Stdout) { Write-Warning 'Uncommitted changes under backend/runner are not part of the build.' }

$r = Invoke-Native { aws codebuild start-build --region $Region --project-name $project --source-version $Branch --query 'build.id' --output text }
if ($r.Code -ne 0 -or -not $r.Stdout) { throw "start-build failed (is the build stack deployed?): $($r.Stderr)" }
$buildId = $r.Stdout
Write-Host "Build   : $buildId"
Write-Host "Branch  : $Branch ($($remoteSha.Substring(0,12)))"

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$lastPhase = ''
$status = 'IN_PROGRESS'
while ($true) {
  $r = Invoke-Native { aws codebuild batch-get-builds --region $Region --ids $buildId --query 'builds[0].[buildStatus,currentPhase]' --output text }
  if ($r.Code -ne 0) { throw "batch-get-builds failed: $($r.Stderr)" }
  $status, $phase = $r.Stdout -split '\s+'
  if ($phase -ne $lastPhase) { Write-Host ("{0:HH:mm:ss}  {1}" -f (Get-Date), $phase); $lastPhase = $phase }
  if ($status -ne 'IN_PROGRESS') { break }
  if ((Get-Date) -gt $deadline) { throw "Build still running after $TimeoutMinutes minutes: $buildId" }
  Start-Sleep -Seconds 10
}

$r = Invoke-Native { aws codebuild batch-get-builds --region $Region --ids $buildId --query 'builds[0].[resolvedSourceVersion,logs.groupName,logs.streamName]' --output text }
$commit, $logGroup, $logStream = $r.Stdout -split '\s+'

if ($status -ne 'SUCCEEDED') {
  Write-Host "Build $status. Last log lines:"
  if ($logGroup -and $logStream -and $logGroup -ne 'None') {
    $l = Invoke-Native { aws logs get-log-events --region $Region --log-group-name $logGroup --log-stream-name $logStream --limit 40 --query 'events[].message' --output text }
    Write-Host $l.Stdout
  }
  throw "Build $status ($buildId)"
}

# Digest from ECR itself, and proof that the image is there.
if ($commit -notmatch '^[0-9a-f]{40}$') { throw "Unexpected source version '$commit'" }
$tag = "runnerfunction-$($commit.Substring(0,12))-$Environment"
$r = Invoke-Native { aws ecr describe-images --region $Region --repository-name $repoName --image-ids "imageTag=$tag" --query 'imageDetails[0].imageDigest' --output text }
$digest = $r.Stdout
if ($r.Code -ne 0 -or $digest -notmatch '^sha256:[0-9a-f]{64}$') { throw "Image $tag not found in ECR repository $repoName after the build: $($r.Stderr)" }

$r = Invoke-Native { aws sts get-caller-identity --query Account --output text }
if ($r.Code -ne 0 -or $r.Stdout -notmatch '^\d{12}$') { throw "aws sts get-caller-identity failed: $($r.Stderr)" }
$imageUri = "$($r.Stdout).dkr.ecr.$Region.amazonaws.com/${repoName}@$digest"

$out = Write-DeployTemplate -ImageUri $imageUri
Write-Host "BUILT   : $repoName`:$tag"
Write-Host "Digest  : $digest"
Write-Host "ImageUri: $imageUri"
Write-Host "Template: $out"
