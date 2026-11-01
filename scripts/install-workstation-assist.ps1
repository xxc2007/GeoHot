param([Parameter(Mandatory=$true)][string]$Config, [int]$SlotCount = 1, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$taskName = 'GEOHOT-Safe-Extraction-Assist'
if ($Remove) {
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    Write-Output 'Disabled future runs. Let any finite session finish before maintenance.'
    exit 0
}
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$configPath = (Resolve-Path -LiteralPath $Config).Path
$privateConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($configPath.StartsWith($repoPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Configuration must be outside the repository.' }
$statePath = [IO.Path]::GetFullPath($privateConfig.stateDirectory)
if ($statePath -eq $repoPath -or $statePath.StartsWith($repoPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'State must be outside the repository.' }
if ($configPath.Contains('"') -or $repoPath.Contains('"')) { throw 'Unsupported quote in path.' }
Get-Command node.exe | Out-Null
if ($SlotCount -lt 1 -or $SlotCount -gt 4) { throw 'SlotCount must be 1..4; more slots need fresh PSI-clean weeks on the server.' }
$runnerPath = Join-Path $repoPath 'scripts/run-workstation-assist.ps1'
$slotsArg = if ($SlotCount -gt 1) { ' -SlotCount {0}' -f $SlotCount } else { '' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Config "{1}"{2}' -f $runnerPath,$configPath,$slotsArg) -WorkingDirectory $repoPath
$logon = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -RunOnlyIfNetworkAvailable -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon,$periodic) -Settings $settings -Principal $principal -Description ('Bounded {0}-slot public body extraction. Server remains independent. Maintenance ownership and resource gates fail closed.' -f $SlotCount) -Force | Out-Null
Write-Output ('Installed {0}; current-user logon and five-minute eligibility retries, overlapping sessions ignored, {1} slot(s).' -f $taskName,$SlotCount)
