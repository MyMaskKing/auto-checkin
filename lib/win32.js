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
    timeout: 15000, // 无超时会让整个编排无限挂起，直到任务计划强杀
  });
  if (r.error || r.status !== 0) {
    const reason = r.error ? `${r.error.code || ''} ${r.error.message}`.trim() : (r.stderr || r.status);
    throw new Error(`进程快照失败：${reason}`);
  }
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : [];
}

function pathEq(a, b) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

// 只按精确 PID 杀进程树，禁止按进程名批量杀。进程已自然退出视为成功。
function killTree(pid) {
  const r = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  const text = (r.stdout || '') + (r.stderr || '') + (r.error ? ` ${r.error.message}` : '');
  const gone = /not find|找不到|no running instance/i.test(text);
  return { ok: !r.error && (r.status === 0 || gone), out: text };
}

// 启动高频窗口隐藏守护（隐藏 rootPid 进程树的所有可见窗口）
// 不用 detached：部分机器上 detached 子进程不会真正执行脚本；脚本内置 RootPid 消失后自动退出
function startHideGuard(rootPid, processNames) {
  const script = path.join(__dirname, 'hide-windows.ps1');
  const child = spawn('powershell.exe', [
    ...PS, '-WindowStyle', 'Hidden', '-File', script,
    '-RootPid', String(rootPid), '-Names', processNames.join(','),
  ], { windowsHide: true, stdio: 'ignore' });
  return child;
}

module.exports = { snapshot, pathEq, killTree, startHideGuard };
