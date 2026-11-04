#!/usr/bin/env node
// WorkBuddy + Qoder CN 每日无感签到编排入口
// 用法：
//   node runner.js --app=all|workbuddy|qoder [--status] [--keep] [--config=path]
// 退出码：0 成功/已领取/跳过；2 登录态失效；3 其他失败（混合时取最严重）
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Cdp, sleep } = require('./lib/cdp');
const win32 = require('./lib/win32');

const ROOT = __dirname;

// ---------- 参数 ----------
function parseArgs(argv) {
  const o = { app: 'all', status: false, keep: false, config: path.join(ROOT, 'config.json') };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--app=')) o.app = a.slice(6);
    else if (a === '--status') o.status = true;
    else if (a === '--keep') o.keep = true;
    else if (a.startsWith('--config=')) o.config = a.slice(9);
  }
  return o;
}
const args = parseArgs(process.argv);
const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));

// ---------- 日志 ----------
function makeLogger() {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(ROOT, 'logs', `${day}.log`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (line) => {
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    const text = `[${ts}] ${line}`;
    console.log(text);
    fs.appendFileSync(file, text + '\n', 'utf8');
  };
}
const log = makeLogger();

const STATUS_ICON = {
  claimed: '✅',
  already: '✔',
  unauthenticated: '⚠️',
  failed: '❌',
  skipped: '⏸️',
};
const SEVERITY = { claimed: 0, already: 0, skipped: 0, unauthenticated: 2, failed: 3 };

function notify(title, body) {
  if (!config.toast) return;
  try {
    spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(ROOT, 'toast.ps1'),
      '-Title', title, '-Body', body,
    ], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  } catch (e) {
    log(`通知发送失败：${e.message}`);
  }
}

// ---------- 单个 app 的完整生命周期 ----------
async function runApp(key) {
  const appCfg = config.apps[key];
  const adapter = require(`./apps/${key}`);
  const name = adapter.meta.name;
  const exePath = appCfg.exePath;
  const port = appCfg.cdpPort;
  const procName = appCfg.processName || adapter.meta.processName;
  const t0 = Date.now();

  // 1) 运行中 → 默认跳过，绝不触碰用户进程
  const before = win32.snapshot([procName]);
  const existing = before.filter((p) => win32.pathEq(p.path, exePath));
  if (existing.length > 0) {
    log(`[${name}] 检测到客户端正在运行（PID ${existing.map((p) => p.pid).join(',')}），跳过，不重启不关闭`);
    return { key, name, status: 'skipped', detail: '客户端运行中，已跳过自动签到' };
  }

  if (!fs.existsSync(exePath)) {
    log(`[${name}] 可执行文件不存在：${exePath}`);
    return { key, name, status: 'failed', detail: '客户端路径不存在，请检查 config.json' };
  }

  // 2) 启动自己的实例
  const child = spawn(exePath, [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
  ], { windowsHide: true, stdio: 'ignore' });
  const guard = win32.startHideGuard(child.pid, [procName]);
  log(`[${name}] 已静默启动（PID ${child.pid}，CDP ${port}）`);
  const beforePids = new Set(before.map((p) => p.pid));

  let browser = null;
  let result;
  try {
    // 3) 等 CDP 就绪并最小化
    browser = await Cdp.waitReady(port, (config.readyTimeoutSec || 90) * 1000);
    await browser.minimizeAll();

    // 4) 签到（先查后领，适配器内部保证已领取不发写请求）
    result = await adapter.signIn(browser, appCfg, (m) => log(`[${name}] ${m}`), { statusOnly: args.status });
    log(`[${name}] ${result.status}：${result.detail}${result.gained ? `（${result.gained}）` : ''}`);
  } catch (e) {
    result = { key, name, status: 'failed', detail: String(e.message || e).slice(0, 200) };
    log(`[${name}] 异常：${result.detail}`);
  } finally {
    if (browser) browser.close();

    // 5) 只关闭自己启动的实例（--keep 除外）
    if (args.keep) {
      log(`[${name}] --keep 保留客户端进程`);
      guard.kill();
    } else {
      // 优先让客户端自己优雅退出
      try {
        const b2 = await Cdp.waitReady(port, 3000);
        await b2.closeBrowser();
        b2.close();
      } catch { /* 连接不上走强杀兜底 */ }

      const exited = await Promise.race([
        new Promise((r) => child.once('exit', () => r(true))),
        sleep((config.graceCloseSec || 20) * 1000).then(() => false),
      ]);
      if (!exited) {
        // 强杀兜底：先杀本次启动的主进程树，再对差集中仍存活的同名进程补刀
        // 绝不用进程名批量杀，防止误杀用户期间手动打开的同名实例
        win32.killTree(child.pid);
        await sleep(1500);
        const after = win32.snapshot([procName]).filter(
          (p) => !beforePids.has(p.pid) && win32.pathEq(p.path, exePath));
        for (const p of after) {
          const k = win32.killTree(p.pid);
          if (!k.ok) log(`[${name}] 结束自启进程 PID ${p.pid} 失败：${k.out.trim().slice(0, 100)}`);
        }
        log(`[${name}] 优雅退出超时，已强制结束自启进程树`);
      } else {
        log(`[${name}] 客户端已优雅退出`);
      }
      guard.kill();
    }
  }

  result.key = key;
  result.name = name;
  result.costMs = Date.now() - t0;
  return result;
}

// ---------- 主编排 ----------
(async () => {
  const keys = args.app === 'all' ? Object.keys(config.apps) : [args.app];
  log(`===== 自动签到开始（${keys.join('、')}${args.status ? '，仅查询' : ''}）=====`);

  const results = [];
  for (const key of keys) {
    if (!config.apps[key]) {
      log(`未知 app：${key}`);
      results.push({ key, name: key, status: 'failed', detail: 'config.json 中无此配置' });
      continue;
    }
    results.push(await runApp(key));
  }

  if (args.status) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const title = '每日签到结果';
    const body = results
      .map((r) => `${STATUS_ICON[r.status] || '•'} ${r.name}：${r.detail}`)
      .join('\n');
    log(`结果：${body.replace(/\n/g, ' | ')}`);
    notify(title, body);
    await sleep(3000); // 等 toast 进程发出
  }

  const code = results.reduce((mx, r) => Math.max(mx, SEVERITY[r.status] ?? 3), 0);
  log(`===== 结束（退出码 ${code}）=====`);
  process.exit(code);
})().catch((e) => {
  log(`编排致命异常：${e.stack || e.message}`);
  notify('每日签到异常', String(e.message || e).slice(0, 150));
  process.exit(3);
});
