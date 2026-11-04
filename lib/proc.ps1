param([string]$Names = "")
# 按进程名快照运行中的进程，输出 JSON：[{pid,name,path}]
$nameSet = $Names -split ',' | Where-Object { $_ }
if (-not $nameSet) { '[]'; exit 0 }
try {
  $rows = Get-CimInstance Win32_Process | Where-Object { $nameSet -contains $_.Name }
  $out = foreach ($p in $rows) {
    [pscustomobject]@{ pid = [int]$p.ProcessId; name = $p.Name; path = $p.ExecutablePath }
  }
  if ($out) { @($out) | ConvertTo-Json -Compress -Depth 2 } else { '[]' }
} catch {
  '[]'
}
