param([string]$NodePath = 'node.exe')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$oldDir = 'D:\tmp\geohot-upgrade-20261019\qoder-reverse-continuous-20261021'
$ownerLock = 'D:\tmp\geohot-upgrade-20261019\qoder-reverse-3425.owner.lock'
$exe = 'D:\magpie-windows-amd64.exe'
$taskName = 'GEOHOT-Qoder-Reverse-20261021'
$mutex = New-Object System.Threading.Mutex($false, 'Local\GEOHOT-Gateway-Watch-20261024')
$held = $false
function Save-State($value) {
  $tmp = Join-Path $root 'watch-state.tmp'
  $value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination (Join-Path $root 'watch-state.json') -Force
}
try {
  try { $held = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
  if (-not $held) { exit 0 }
  # Check stop flags before inspection and again immediately before every action.
  function Is-Stopped { (Test-Path -LiteralPath (Join-Path $root 'disabled.flag')) -or (Test-Path -LiteralPath (Join-Path $oldDir 'operator.stop')) }
  if (Is-Stopped) { exit 0 }
  $previous = $null
  $stateFile = Join-Path $root 'watch-state.json'
  if (Test-Path -LiteralPath $stateFile) { $previous = Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json }
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
  # Inspect all processes with the same executable name; an unreadable path fails closed.
  $candidates = @(Get-CimInstance Win32_Process -Filter "Name='magpie-windows-amd64.exe'")
  if (@($candidates | Where-Object { -not $_.ExecutablePath }).Count -gt 0) { throw 'inspection_failed' }
  $matching = @($candidates | Where-Object { [string]::Equals($_.ExecutablePath, $exe, [System.StringComparison]::OrdinalIgnoreCase) })
  $samePath = $matching.Count -gt 0
  # Enumerate listeners instead of treating a cmdlet no-match error as a network failure.
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
  $occupied = @($listeners | Where-Object { $_.LocalPort -eq 3425 }).Count -gt 0
  $loopback = @($listeners | Where-Object { $_.LocalPort -eq 3425 -and $_.LocalAddress -eq '127.0.0.1' }).Count -gt 0
  # A foreign listener never authorizes starting the reverse task.
  $healthyLocal = $loopback -and $samePath -and @($listeners | Where-Object { $_.LocalPort -eq 3425 -and $_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -in @($matching.ProcessId) }).Count -gt 0
  $oldFile = Join-Path $oldDir 'last-state.json'
  $absent = -not (Test-Path -LiteralPath $oldFile)
  $oldState = $null
  if (-not $absent) { $oldState = Get-Content -Raw -LiteralPath $oldFile | ConvertFrom-Json }
  $snapshot = @{
    disabled = $false; operatorStop = $false; inspectionOk = $true
    listenerPresent = [bool]$healthyLocal; samePathProcess = [bool]($samePath -or $occupied)
    exeExists = (Test-Path -LiteralPath $exe -PathType Leaf)
    taskState = [string]$task.State; lastTaskResult = [long]$info.LastTaskResult
    ownerLock = (Test-Path -LiteralPath $ownerLock); lastStateAbsent = $absent; lastState = $oldState
    now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); consumedToken = $previous.consumedToken
  }
  $decisionText = ($snapshot | ConvertTo-Json -Depth 8 -Compress) | & $NodePath (Join-Path $root 'decision.mjs') --stdin
  if ($LASTEXITCODE -ne 0) { throw 'decision_failed' }
  $decision = $decisionText | ConvertFrom-Json
  $record = @{ at = [DateTimeOffset]::UtcNow.ToString('o'); reason = $decision.reason; consumedToken = $previous.consumedToken; gatewayLaunchAttempted = $false; taskLaunchAttempted = $false }
  if ($decision.startGateway -and -not (Is-Stopped)) {
    # Recheck immediately; never kill any process or release another owner's lock.
    $again = @(Get-CimInstance Win32_Process -Filter "Name='magpie-windows-amd64.exe'")
    $ports = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 3425 })
    if ($again.Count -eq 0 -and $ports.Count -eq 0) {
      $record.gatewayLaunchAttempted = $true
      Save-State $record
      Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -WindowStyle Hidden | Out-Null
    }
  }
  if ($decision.startTask -and -not (Is-Stopped)) {
    # Persist token before launching: even a failed launch requires operator review.
    if ((Test-Path -LiteralPath $ownerLock) -or (Get-ScheduledTask -TaskName $taskName).State -ne 'Ready') { $record.reason = 'prelaunch_state_changed' }
    else {
      $record.consumedToken = $decision.token
      $record.taskLaunchAttempted = $true
      Save-State $record
      Start-ScheduledTask -TaskName $taskName
    }
  }
  Save-State $record
} catch {
  # Do not persist exception text, command lines, endpoints, keys or environment.
  if ($held) { try {
    $consumed = $previous.consumedToken
    if ($null -ne $record -and $record.consumedToken) { $consumed = $record.consumedToken }
    Save-State @{ at = [DateTimeOffset]::UtcNow.ToString('o'); reason = 'inspection_or_action_failed'; consumedToken = $consumed }
  } catch {} }
  exit 1
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
