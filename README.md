# WorkBuddy / Qoder CN 每日无感自动签到

每日定时由 Windows 任务计划静默唤起客户端 → 在客户端自身登录态内完成签到 → 退出客户端（约 1 分钟，不常驻内存）→ Windows 原生 toast 通知结果（WinRT 不可用时降级为 8 秒自动关闭的对话框）。

> **让 AI 助手安装到新电脑**：把整个目录给对方，让其 AI 编码助手阅读项目根目录的 **`AGENTS.md`**（环境自检、安装路径探测、config 适配、验证与任务计划注册的完整执行手册）。分享时排除 `.ai/`、`logs/`。

## 原理（2026-11-03 实测）

- **WorkBuddy**：带 `--remote-debugging-port` 启动后，经客户端自带 RPC 桥 `window.__wbInvoke('auth:getCheckinStatus' / 'auth:claimDailyCheckin')` 完成。鉴权与腾讯图灵风控签名由客户端主进程自动处理，不读取、不解密本机 token 文件（新版客户端已把 token 改为 AES-GCM 封装，静态解密不可行）。
- **Qoder CN**：经 CDP 打开「权益中心」活动页 `https://openapi.qoder.com.cn/growth-page/activity-iframe`，同源调用：
  - `GET /sash/api/v1/me/campaigns` 查询；
  - `POST /sash/api/v1/me/campaigns/{campaignId}/claim` 领取（campaignId 每次从列表动态获取，活动「每天领 100 Credits」每日 10:00 UTC+8 刷新）。
- 登录态完全由客户端自己持有（cookie/Electron session），脚本不保存任何凭据，日志不记录 token/cookie。
- 先查后领、接口幂等；同一天重复运行只会得到「今日已领取」。

## 进程安全策略

- 运行前检测到客户端**已在运行**，按 `config.json` 顶层 `onRunning` 策略处理：
  - `skip`（默认值/未知值）：直接跳过，**不重启、不关闭**任何用户进程，通知里说明"运行中已跳过"。
  - `attach`：用 4 秒短超时探测该客户端的 CDP 端口——端口已开放则直接附加签到，结束只断开调试连接、**不关闭进程**；端口未开放（客户端以普通方式启动）则回退跳过，通知中注明"未开放调试端口"。
  - CDP 端口是进程启动级开关、运行中无法补开，启用 attach 需让客户端**日常就带调试参数启动**。一键改写本机全部相关快捷方式（桌面/开始菜单/任务栏/启动文件夹，幂等，可先 `-DryRun` 预览）：
    ```powershell
    powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1 -DryRun
    powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1
    ```
    脚本按 `config.json` 中各 app 的 `exePath`（Qoder 另含可选 `launcherPath`）匹配快捷方式目标并追加参数；Qoder CN 的快捷方式指向 Launcher（`Qoder CN Launcher.exe`），实测 Launcher 会把命令行参数原样透传给真实客户端。也可手动把快捷方式「目标」改为（端口与 `config.json` 一致）：
    ```powershell
    "E:\Dev_Software\WorkBuddy\WorkBuddy.exe" --remote-debugging-port=9222 --remote-allow-origins=*
    "C:\Users\IT\AppData\Local\Qoder CN\Qoder CN Launcher\Qoder CN Launcher.exe" --remote-debugging-port=9223 --remote-allow-origins=*
    ```
    调试端口仅监听 127.0.0.1。附加期间 WorkBuddy 为纯后台 RPC 无界面打扰；Qoder 需模拟点击打开「权益中心」，会在当前窗口短暂抢焦点并弹出活动页。
  - 已知边界：直接双击 exe、客户端自更新后的自动重启不走快捷方式，此时实例不带调试端口，定时任务仍回退 skipped（通知中注明）；客户端升级若覆盖了快捷方式，重跑一次 `install-shortcuts.ps1` 即可修复。
- 只关闭脚本自己启动的实例：按启动前后 PID 差集逐个 `taskkill /PID /T`，**不使用按进程名批量结束**；attach 路径不做任何进程结束操作。
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
| `toast.ps1` | 结果通知：WinRT 原生 toast 优先（AUMID `AutoCheckin.Daily` 每次运行幂等自注册，未注册 AUMID 的 toast 会被静默丢弃）；失败降级 `WScript.Shell.Popup` 对话框 |
| `install-shortcuts.ps1` | 幂等改写本机指向两客户端的快捷方式，追加 CDP 调试参数（`onRunning=attach` 的无感配套，支持 `-DryRun`；Qoder 经 `launcherPath` 匹配 Launcher 快捷方式） |
| `config.json` | 客户端路径、CDP 端口、超时、`onRunning` 策略 |
| `logs/YYYY-MM-DD.log` | 每日运行日志 |

## 故障排查

| 现象 | 处理 |
|---|---|
| 通知"登录态失效" | 手动打开对应客户端，确认登录正常后重跑 |
| 通知"CDP 未就绪" | 本机安全软件拦截调试端口；确认端口（9222/9223）未被占用 |
| Qoder 活动页改版导致失败 | 失败会直接报错、不会乱点；更新 `apps/qoder.js` 中的定位常量 |
| 没收到通知 | 先看 `logs/` 末尾有无「结果：」行。原生 toast 走通知平台（受系统通知开关/专注助手影响），被禁用时脚本自动降级中央 Popup（user32 渲染，不受勿扰影响）；任务仅在用户登录会话运行，锁屏/未登录时无交互桌面属正常 |
| attach 模式仍提示"未开放调试端口" | 该实例不是从改写后的快捷方式启动的（如直接双击 exe、客户端自更新重启）。重跑 `install-shortcuts.ps1` 后彻底退出客户端再从快捷方式打开；`Qoder CN IDE` 的快捷方式不会被改写，也不是签到目标 |
