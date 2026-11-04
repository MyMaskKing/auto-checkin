// Windows 进程/窗口辅助：快照、按 PID 杀进程树、启动窗口隐藏守护
const { spawnSync, spawn } = require('node:child_process');
const path = require('node:path');

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

// 返回 [{pid,name,path}]
function snapshot(processNames) {
  const script = path.join(__dirname, 'proc.ps1');
  const r = spawnSync('powershell.exe', [...PS, '-File', script, '-Names', processNames.join(',')], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`进程快照失败：${r.stderr || r.status}`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : [];
}

function pathEq(a, b) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

// 只按精确 PID 杀进程树，禁止按进程名批量杀。进程已自然退出视为成功。
function killTree(pid) {
  const r = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
  const text = (r.stdout || '') + (r.stderr || '');
  const gone = /not find|找不到|no running instance/i.test(text);
  return { ok: r.status === 0 || gone, out: text };
}

// 启动高频窗口隐藏守护（隐藏 rootPid 进程树的所有可见窗口）
function startHideGuard(rootPid, processNames) {
  const script = path.join(__dirname, 'hide-windows.ps1');
  const child = spawn('powershell.exe', [
    ...PS, '-WindowStyle', 'Hidden', '-File', script,
    '-RootPid', String(rootPid), '-Names', processNames.join(','),
  ], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  return child;
}

module.exports = { snapshot, pathEq, killTree, startHideGuard };
