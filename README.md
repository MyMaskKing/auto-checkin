# WorkBuddy / Qoder CN 每日无感自动签到

每日定时由 Windows 任务计划静默唤起客户端 → 在客户端自身登录态内完成签到 → 退出客户端（约 1 分钟，不常驻内存）→ Windows 对话框通知结果（8 秒自动关闭）。

> **让 AI 助手安装到新电脑**：把整个目录给对方，让其 AI 编码助手阅读项目根目录的 **`AGENTS.md`**（环境自检、安装路径探测、config 适配、验证与任务计划注册的完整执行手册）。分享时排除 `.ai/`、`logs/`。

## 原理（2026-11-03 实测）

- **WorkBuddy**：带 `--remote-debugging-port` 启动后，经客户端自带 RPC 桥 `window.__wbInvoke('auth:getCheckinStatus' / 'auth:claimDailyCheckin')` 完成。鉴权与腾讯图灵风控签名由客户端主进程自动处理，不读取、不解密本机 token 文件（新版客户端已把 token 改为 AES-GCM 封装，静态解密不可行）。
- **Qoder CN**：经 CDP 打开「权益中心」活动页 `https://openapi.qoder.com.cn/growth-page/activity-iframe`，同源调用：
  - `GET /sash/api/v1/me/campaigns` 查询；
  - `POST /sash/api/v1/me/campaigns/{campaignId}/claim` 领取（campaignId 每次从列表动态获取，活动「每天领 100 Credits」每日 10:00 UTC+8 刷新）。
- 登录态完全由客户端自己持有（cookie/Electron session），脚本不保存任何凭据，日志不记录 token/cookie。
- 先查后领、接口幂等；同一天重复运行只会得到「今日已领取」。

## 进程安全策略

- 运行前检测到客户端**已在运行**：默认直接跳过，**不重启、不关闭**任何用户进程，通知里说明"运行中已跳过"。
- 只关闭脚本自己启动的实例：按启动前后 PID 差集逐个 `taskkill /PID /T`，**不使用按进程名批量结束**。
- 签到窗口由 Win32 守护高频隐藏，启动期间任务栏最多短暂闪烁。

## 手动运行

```powershell
cd D:\AI_Workspace\auto-checkin
node runner.js --app=all          # 两个都签
node runner.js --app=workbuddy    # 只签 WorkBuddy
node runner.js --app=qoder        # 只签 Qoder
node runner.js --status           # 只查询状态，不领取
node runner.js --keep             # 签到后保留客户端（排障用）
node runner.js --config=xxx.json  # 使用其他配置
```

退出码：`0` 成功/已领取/跳过；`2` 登录态失效（需手动打开对应客户端重新登录）；`3` 其他失败。

## 注册每日任务

```powershell
powershell -ExecutionPolicy Bypass -File install-task.ps1            # 默认每天 10:30
powershell -ExecutionPolicy Bypass -File install-task.ps1 -Time 11:00
powershell -ExecutionPolicy Bypass -File uninstall-task.ps1         # 卸载
```

任务仅在当前用户登录时运行（需要启动 GUI、弹通知）；设置了"错过时间尽快补跑"，10:30 未开机则登录后自动执行一次。

## 文件说明

| 文件 | 作用 |
|---|---|
| `runner.js` | 编排入口：进程检测、静默启动、签到、退出、通知 |
| `apps/workbuddy.js` / `apps/qoder.js` | 两个客户端适配器（定位点集中于此，升级失效时改这里） |
| `lib/cdp.js` | 零依赖 CDP 客户端（Node 22 内置 fetch/WebSocket） |
| `lib/win32.js`、`lib/proc.ps1`、`lib/hide-windows.ps1` | 进程快照、进程树结束、窗口隐藏守护 |
| `toast.ps1` | 结果通知（`WScript.Shell.Popup` 对话框，8 秒自动关闭；不用 WinRT toast，未注册 AUMID 会被静默丢弃） |
| `config.json` | 客户端路径、CDP 端口、超时、`onRunning` 策略 |
| `logs/YYYY-MM-DD.log` | 每日运行日志 |

## 故障排查

| 现象 | 处理 |
|---|---|
| 通知"登录态失效" | 手动打开对应客户端，确认登录正常后重跑 |
| 通知"CDP 未就绪" | 本机安全软件拦截调试端口；确认端口（9222/9223）未被占用 |
| Qoder 活动页改版导致失败 | 失败会直接报错、不会乱点；更新 `apps/qoder.js` 中的定位常量 |
| 没收到通知 | 先看 `logs/` 末尾有无「结果：」行。弹窗由 user32 直接渲染、不受勿扰模式影响；任务仅在用户登录会话运行，锁屏/未登录时无交互桌面属正常 |
