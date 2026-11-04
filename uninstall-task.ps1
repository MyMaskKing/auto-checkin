param([string]$TaskName = 'AutoCheckin-Daily')
$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($t) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Scheduled task removed: $TaskName"
} else {
  Write-Host "Scheduled task not found: $TaskName"
}
