# Register the daily auto check-in scheduled task (runs when the current user is logged on)
# Usage: powershell -ExecutionPolicy Bypass -File install-task.ps1 [-Time 10:30]
param(
  [string]$Time = '10:30',
  [string]$TaskName = 'AutoCheckin-Daily'
)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot

$node = (Get-Command node.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $node -Argument 'runner.js --app=all' -WorkingDirectory $dir

$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.Add([timespan]::Parse($Time)))

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force `
  -Description 'WorkBuddy / Qoder CN silent daily check-in (launches the clients hidden, claims credits, exits and shows a toast)' | Out-Null

Write-Host "Scheduled task registered: $TaskName at $Time daily (missed runs are caught up after logon)"
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
