# Invokes the DEPLOYED runner in diagnose mode ({ "diagnose": true }, no student code) and prints what the platform lets
# the sandbox do: every step with success or errno, once as a direct child of the handler, once as a grandchild, and
# once through the real launcher (including the launcher's own report of the step that failed).
#
#   powershell -File scripts\diagnose.ps1 [-FunctionName micro-credentialing-runner-dev] [-Region us-east-1] [-Json out.json]
#   powershell -File scripts\diagnose.ps1 -ReplyFile saved.json     (print a saved reply, no AWS call)
param(
  [string]$FunctionName = 'micro-credentialing-runner-dev',
  [string]$Region = 'us-east-1',
  [string]$Json = '',       # optional: also save the raw reply here
  [string]$ReplyFile = ''   # optional: print this saved reply instead of invoking the function
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\native.ps1"

$work = Join-Path $env:TEMP "runner-diagnose-$PID"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$payloadFile = Join-Path $work 'payload.json'
$outFile = Join-Path $work 'reply.json'
try {
  if ($ReplyFile) {
    $text = Get-Content -Raw -Encoding UTF8 $ReplyFile
    Copy-Item $ReplyFile $outFile -Force
  } else {
    [System.IO.File]::WriteAllText($payloadFile, '{"diagnose":true}', (New-Object System.Text.UTF8Encoding($false)))
    $r = Invoke-Native { aws lambda invoke --region $Region --function-name $FunctionName --payload "fileb://$payloadFile" --cli-read-timeout 120 $outFile }
    if ($r.Code -ne 0) { throw "lambda invoke failed: $($r.Stderr)" }
    $meta = $r.Stdout | ConvertFrom-Json
    $text = Get-Content -Raw -Encoding UTF8 $outFile
    if ($meta.FunctionError) { throw "The function failed ($($meta.FunctionError)): $($text.Substring(0, [Math]::Min(400, $text.Length)))" }
  }
  if ($Json) { Copy-Item $outFile $Json -Force; Write-Host "Raw reply saved to $Json" }
  $body = $text | ConvertFrom-Json
  if (-not $body.diagnose) { throw "Not a diagnose reply (is the new image deployed?): $($text.Substring(0, [Math]::Min(300, $text.Length)))" }
  if ($body.error) { throw "Diagnose failed inside the function: $($body.error)" }

  function Cell($probe, $name) {
    $row = @($probe.results) | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if (-not $row) { return '-' }
    if ($row.ok) { return 'ok' }
    return ("ERR {0} {1}" -f $row.errno, $row.err).Trim()
  }
  function Detail($probe, $name) {
    $row = @($probe.results) | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if ($row) { return $row.detail }
    return ''
  }

  $modes = [ordered]@{ 'direct child' = $body.direct; 'grandchild' = $body.grandchild; 'via launcher' = $body.viaLauncher.probe }
  foreach ($mode in $modes.Keys) {
    if ($modes[$mode].error) { Write-Warning "$mode probe did not run: $($modes[$mode].error) $($modes[$mode].stderr)" }
  }

  $names = @()
  foreach ($mode in $modes.Keys) { foreach ($row in @($modes[$mode].results)) { if ($names -notcontains $row.name) { $names += $row.name } } }

  Write-Host ''
  Write-Host "Runner: $FunctionName ($Region)"
  Write-Host ('Kernel: ' + (Detail $body.direct 'uname -r'))
  Write-Host ('Status: ' + (Detail $body.direct '/proc/self/status: Seccomp, NoNewPrivs, CapEff'))
  Write-Host ''
  Write-Host 'Launcher report (the real launcher, as the handler uses it):'
  $l = $body.viaLauncher.launcher
  if ($l) {
    Write-Host ("  seccomp={0}  landlock={1}  step={2}  errno={3}  subreaper_errno={4}  exit={5}  signal={6}" -f $l.seccomp, $l.landlock, $l.step, $l.errno, $l.subreaperErrno, $l.exitCode, $l.signal)
  } else {
    Write-Host '  the launcher did not report (it was killed or did not start)'
  }

  Write-Host ''
  $table = foreach ($name in $names) {
    [pscustomobject]@{
      Probe = if ($name.Length -gt 66) { $name.Substring(0, 66) } else { $name }
      Direct = Cell $body.direct $name
      Grandchild = Cell $body.grandchild $name
      ViaLauncher = Cell $body.viaLauncher.probe $name
    }
  }
  $table | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host

  Write-Host 'Details (direct child):'
  foreach ($name in $names) {
    $d = Detail $body.direct $name
    if ($d) { Write-Host ("  {0}: {1}" -f $(if ($name.Length -gt 66) { $name.Substring(0, 66) } else { $name }), $d) }
  }

  $failed = @($table | Where-Object { $_.Direct -ne 'ok' -or $_.Grandchild -ne 'ok' })
  Write-Host ''
  Write-Host ("{0} of {1} probes failed in the direct or grandchild run." -f $failed.Count, @($table).Count)
}
finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
