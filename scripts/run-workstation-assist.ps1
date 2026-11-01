param([Parameter(Mandatory=$true)][string]$Config, [int]$SlotCount = 1)
$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path -LiteralPath $Config).Path
$privateConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$statePath = [IO.Path]::GetFullPath($privateConfig.stateDirectory)
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($statePath -eq $repoPath -or $statePath.StartsWith($repoPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'State must be outside repository.' }
New-Item -ItemType Directory -Path $statePath -Force | Out-Null
$logPath = Join-Path $statePath ('assist-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))
if (Test-Path -LiteralPath (Join-Path $statePath 'extraction-assist.lock')) {
    Add-Content -LiteralPath $logPath -Value ('{0} isolated: existing instance lock; no task started' -f (Get-Date -Format o))
    exit 3
}
Set-Location -LiteralPath $repoPath
Add-Content -LiteralPath $logPath -Value ('{0} starting eligibility check' -f (Get-Date -Format o))
if ($SlotCount -lt 1 -or $SlotCount -gt 2) { throw 'SlotCount must be 1 or 2.' }
$slotsArg = @(); if ($SlotCount -gt 1) { $slotsArg = @('--slots', "$SlotCount") }
& node.exe (Join-Path $repoPath 'scripts/workstation-extraction-assist.ts') --config $configPath --run-seconds 600 @slotsArg 2>&1 | Out-File -LiteralPath $logPath -Append -Encoding utf8
exit $LASTEXITCODE
