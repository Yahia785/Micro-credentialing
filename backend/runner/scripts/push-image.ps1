# Pushes the built runner image to the runner's own ECR repository from Windows with crane, bypassing `docker push`
# (which fails on this machine because traffic leaving the Docker VM gets corrupted), then writes the deploy template.
# Run `sam build` first and `scripts\create-repo.ps1` once before the first push.
#
#   powershell -File scripts\push-image.ps1 [-Environment dev]
#
# Uses a throwaway DOCKER_CONFIG so Docker's own config and credentials are never touched.
param(
  [string]$Environment = 'dev',
  [string]$Region = 'us-east-1',
  [string]$LocalImage = 'runnerfunction:dev',
  [string]$Crane = 'D:\tools\crane\crane.exe',
  [string]$WorkDir = 'D:\tmp\runner-push'
)
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\native.ps1"           # Invoke-Native: stderr of native commands never stops the script by itself
. "$PSScriptRoot\deploy-template.ps1"  # Write-DeployTemplate

if (-not (Test-Path $Crane)) { throw "crane not found at $Crane" }
$repoName = "micro-credentialing-runner-$Environment"

$r = Invoke-Native { docker images -q $LocalImage }
if ($r.Code -ne 0) { throw "docker images failed: $($r.Stderr)" }
$imageId = ($r.Stdout -split "`n" | Select-Object -First 1)
if (-not $imageId) { throw "Local image $LocalImage not found. Run sam build first." }
$tag = "runnerfunction-$imageId-$Environment"

$r = Invoke-Native { aws sts get-caller-identity --query Account --output text }
if ($r.Code -ne 0 -or $r.Stdout -notmatch '^\d{12}$') { throw "aws sts get-caller-identity failed: $($r.Stderr)" }
$account = $r.Stdout
$r = Invoke-Native { aws ecr describe-repositories --region $Region --repository-names $repoName --query 'repositories[0].repositoryName' --output text }
if ($r.Code -ne 0) {
  if ($r.Stderr -match 'RepositoryNotFoundException') { throw "ECR repository $repoName not found. Run scripts\create-repo.ps1 first." }
  throw "describe-repositories failed: $($r.Stderr)"
}

$registry = "$account.dkr.ecr.$Region.amazonaws.com"
$target = "$registry/${repoName}:$tag"
Write-Host "Image   : $LocalImage ($imageId)"
Write-Host "Target  : $target"

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$tar = Join-Path $WorkDir "$tag.tar"
$env:DOCKER_CONFIG = Join-Path $WorkDir 'docker-config'
New-Item -ItemType Directory -Force -Path $env:DOCKER_CONFIG | Out-Null

try {
  # Piping in PowerShell mangles the password (that is what broke docker login), so pipe inside cmd.exe.
  # (crane warns on stderr that the credentials are stored unencrypted in the throwaway config; that is expected.)
  $loginCommand = "aws ecr get-login-password --region $Region | `"$Crane`" auth login $registry -u AWS --password-stdin"
  $r = Invoke-Native { cmd /c $loginCommand }
  if ($r.Code -ne 0) { throw "crane auth login failed: $($r.Stderr)" }

  Write-Host 'docker save ...'
  $r = Invoke-Native { docker save -o $tar $LocalImage }
  if ($r.Code -ne 0) { throw "docker save failed: $($r.Stderr)" }
  Write-Host ("Tar     : {0:N0} MB" -f ((Get-Item $tar).Length / 1MB))

  # Connections to ECR get reset now and then. Blobs already uploaded are skipped, so each attempt resumes.
  $maxAttempts = 5
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    Write-Host "crane push, attempt $attempt of $maxAttempts ..."
    # crane logs progress on stderr, so errors are set to 'Continue' for this call; only the exit code decides.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $lines = @(& $Crane push $tar $target 2>&1 | ForEach-Object { "$_"; Write-Host "$_" })
      $code = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previous
    }
    if ($code -eq 0) { break }
    $uploaded = @($lines | Where-Object { $_ -match 'pushed blob' }).Count
    $skipped = @($lines | Where-Object { $_ -match 'existing blob' }).Count
    Write-Host "attempt $attempt failed: $uploaded blob(s) uploaded, $skipped already present"
    if ($attempt -eq $maxAttempts) { throw "crane push failed after $maxAttempts attempts" }
    Start-Sleep -Seconds 5
    # The ECR token is still valid (12 h), so no new login is needed.
  }

  # Ask ECR for the digest (not crane or a local computation) and make sure the image is really there.
  $r = Invoke-Native { aws ecr describe-images --region $Region --repository-name $repoName --image-ids "imageTag=$tag" --query 'imageDetails[0].imageDigest' --output text }
  $digest = $r.Stdout
  if ($r.Code -ne 0 -or $digest -notmatch '^sha256:[0-9a-f]{64}$') { throw "Image $tag not found in ECR repository $repoName after the push: $($r.Stderr)" }
  Write-Host "PUSHED  : $target"
  Write-Host "Digest  : $digest"

  $imageUri = "$registry/${repoName}@$digest"
  $out = Write-DeployTemplate -ImageUri $imageUri
  Write-Host "ImageUri: $imageUri"
  Write-Host "Template: $out"
}
finally {
  if (Test-Path $tar) { Remove-Item $tar -Force }
  if (Test-Path $env:DOCKER_CONFIG) { Remove-Item $env:DOCKER_CONFIG -Recurse -Force }   # drops the stored ECR token
  Remove-Item Env:\DOCKER_CONFIG -ErrorAction SilentlyContinue
}
