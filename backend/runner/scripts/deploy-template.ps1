# Dot-source it: `. "$PSScriptRoot\deploy-template.ps1"`. Shared by push-image.ps1 and build-in-aws.ps1.
#
# Writes .aws-sam/deploy-template.yaml: the same as template.yaml, but the function's Code.ImageUri (a placeholder in
# template.yaml) is the image already in ECR (by digest), and the build Metadata is removed. `sam deploy` on this template
# has nothing to build or push. template.yaml itself is unchanged. The file is UTF-8 without BOM. Returns the path of the file.
function Write-DeployTemplate {
  param([Parameter(Mandatory)][string]$ImageUri)
  $runnerDir = Split-Path -Parent $PSScriptRoot
  $text = Get-Content (Join-Path $runnerDir 'template.yaml') -Raw
  $text = $text -replace '(?m)^    Metadata:\r?\n      Dockerfile:.*\r?\n      DockerContext:.*\r?\n      DockerTag:.*\r?\n', ''
  $text = $text -replace '(?m)^(\s+ImageUri: )set-by-scripts\S*', "`${1}$ImageUri"
  if ($text -match 'set-by-scripts' -or $text -match 'DockerContext' -or $text -notmatch [regex]::Escape($ImageUri)) { throw 'could not rewrite template.yaml for the pushed image' }
  $out = Join-Path $runnerDir '.aws-sam\deploy-template.yaml'
  New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
  [System.IO.File]::WriteAllText($out, $text, (New-Object System.Text.UTF8Encoding($false)))
  return $out
}
