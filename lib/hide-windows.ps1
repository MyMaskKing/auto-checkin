param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [Parameter(Mandatory = $true)][string]$Names,
  [int]$IntervalMs = 250,
  [int]$TreeRefreshMs = 2000,
  [int]$IdleExitSec = 15
)
# 窗口隐藏守护：只隐藏 RootPid 进程树的窗口（不碰同名的其他实例）。
# 轻量设计：EnumWindows 高频跑（系统调用，极轻）；进程树每 TreeRefreshMs 才算一次。
# RootPid 消失后 IdleExitSec 秒自动退出，避免成为孤儿进程。
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinHideApi {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@

$nameSet = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($n in ($Names -split ',')) { [void]$nameSet.Add($n) }
$filter = ($nameSet | ForEach-Object { "Name='$_'" }) -join ' OR '

$script:tree = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$script:tree.Add($RootPid)

function Refresh-Tree {
  $next = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$next.Add($RootPid)
  try {
    $procs = Get-CimInstance Win32_Process -Filter $filter
    $grown = $true
    while ($grown) {
      $grown = $false
      foreach ($p in $procs) {
        if ($next.Contains([int]$p.ProcessId)) { continue }
        if ($p.ParentProcessId -and $next.Contains([int]$p.ParentProcessId)) {
          [void]$next.Add([int]$p.ProcessId)
          $grown = $true
        }
      }
    }
  } catch { }
  $script:tree = $next
}

$deadMs = 0
$sinceTree = [int]$TreeRefreshMs
while ($true) {
  if ((Get-Process -Id $RootPid -ErrorAction SilentlyContinue)) { $deadMs = 0 } else { $deadMs += $IntervalMs; if ($deadMs -ge ($IdleExitSec * 1000)) { break } }
  if ($sinceTree -ge $TreeRefreshMs) { Refresh-Tree; $sinceTree = 0 } else { $sinceTree += $IntervalMs }

  [WinHideApi]::EnumWindows({
    param($hWnd, $lp)
    $procId = 0
    [void][WinHideApi]::GetWindowThreadProcessId($hWnd, [ref]$procId)
    if ($script:tree.Contains([int]$procId) -and [WinHideApi]::IsWindowVisible($hWnd)) {
      [void][WinHideApi]::ShowWindow($hWnd, 0) # SW_HIDE
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null

  Start-Sleep -Milliseconds $IntervalMs
}
