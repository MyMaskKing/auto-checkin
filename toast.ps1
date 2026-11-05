param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body
)
# WinRT toast with an unregistered AUMID is silently dropped by the Windows
# notification platform on some machines (Show() succeeds but nothing appears).
# WScript.Shell.Popup is rendered by win32 user32 and stays visible even when
# launched by a hidden host process; it auto-closes after 8 seconds.
# Keep this file ASCII-only; localized text arrives via -Title/-Body arguments.
try {
  $wsh = New-Object -ComObject WScript.Shell
  [void]$wsh.Popup($Body, 8, $Title, 64)
}
catch { }
