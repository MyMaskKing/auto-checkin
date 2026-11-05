param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [string]$AppId = 'AutoCheckin.Daily',
  [string]$DisplayName = 'AutoCheckin'
)
# Keep this file ASCII-only; all localized text arrives via parameters.
# Primary path: native Windows toast under a registered unpackaged AUMID.
# A toast sent with an unregistered AUMID is silently dropped by the
# notification platform, so the HKCU registration is rewritten on every run
# (idempotent, self-healing after registry cleanup).
# Fallback path: WScript.Shell.Popup rendered by user32 when WinRT is
# unavailable or notifications are disabled by policy/user setting.
$ok = $false
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Stop'
try {
  $key = "HKCU:\Software\Classes\AppUserModelId\$AppId"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  Set-ItemProperty -Path $key -Name DisplayName -Value $DisplayName

  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
  if ($notifier.Setting -eq [Windows.UI.Notifications.NotificationSetting]::Enabled) {
    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
      [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $template.GetElementsByTagName('text')
    [void]$texts.Item(0).AppendChild($template.CreateTextNode($Title))
    [void]$texts.Item(1).AppendChild($template.CreateTextNode($Body))
    $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
    $notifier.Show($toast)
    $ok = $true
  }
}
catch {
  $ok = $false
}
finally {
  $ErrorActionPreference = $prevEap
}

if (-not $ok) {
  try {
    $wsh = New-Object -ComObject WScript.Shell
    [void]$wsh.Popup($Body, 8, $Title, 64)
  }
  catch { }
}
