# Creates the runner's own ECR repository (fixed name, keeps the last 5 images). Safe to run again.
# It lives outside the runner stack on purpose: the function needs the image to exist before the stack can create it,
# and a repository owned by SAM's companion stack gets deleted when a template has no image to build.
#
#   powershell -File scripts\create-repo.ps1 [-Environment dev]
param(
  [string]$Environment = 'dev',
  [string]$Region = 'us-east-1'
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\native.ps1"
$name = "micro-credentialing-runner-$Environment"

$r = Invoke-Native { aws ecr describe-repositories --region $Region --repository-names $name --query 'repositories[0].repositoryUri' --output text }
if ($r.Code -eq 0 -and $r.Stdout) {
  Write-Host "Repository exists: $($r.Stdout)"
} elseif ($r.Stderr -match 'RepositoryNotFoundException') {
  $r = Invoke-Native { aws ecr create-repository --region $Region --repository-name $name --image-scanning-configuration scanOnPush=true --query 'repository.repositoryUri' --output text }
  if ($r.Code -ne 0) { throw "create-repository failed: $($r.Stderr)" }
  Write-Host "Created: $($r.Stdout)"
} else {
  throw "describe-repositories failed (exit $($r.Code)): $($r.Stderr)"
}

$policy = "file://$(Join-Path $PSScriptRoot 'ecr-lifecycle-policy.json')"
$r = Invoke-Native { aws ecr put-lifecycle-policy --region $Region --repository-name $name --lifecycle-policy-text $policy --query repositoryName --output text }
if ($r.Code -ne 0) { throw "put-lifecycle-policy failed: $($r.Stderr)" }
Write-Host 'Lifecycle policy set: keep the last 5 images'
