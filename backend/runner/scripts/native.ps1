# Helper for the scripts in this folder (dot-source it: `. "$PSScriptRoot\native.ps1"`).
#
# Windows PowerShell 5.1 turns any stderr output of a native command (aws, docker, crane) into a NativeCommandError,
# and under $ErrorActionPreference = 'Stop' that ends the script even when the command succeeded or its failure
# is expected (for example "repository does not exist"). Invoke-Native runs the command with errors set to
# 'Continue', captures stderr separately, and returns the exit code, so the caller decides what is a failure.
#
#   $r = Invoke-Native { aws ecr describe-repositories --repository-names x }
#   if ($r.Code -ne 0) { ... $r.Stderr ... }       # $r.Stdout is stdout only, trimmed
function Invoke-Native {
  param([Parameter(Mandatory)][scriptblock]$Command)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $all = @(& $Command 2>&1)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  $stdout = ($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" }) -join "`n"
  $stderr = ($all | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" }) -join "`n"
  [pscustomobject]@{ Code = $code; Stdout = $stdout.Trim(); Stderr = $stderr.Trim() }
}
