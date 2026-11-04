# AGENTS.md —— 给 AI 编码助手的安装执行手册

> 本文件面向**在使用者机器上执行安装/适配的 AI 助手**。请严格按步骤执行，不要重写、重构或"优化"业务代码；本项目已在作者机器上通过实测，适配新机器通常只需要改 `config.json` 与注册任务计划。
> 项目原理与人工说明见 `README.md`。

## 0. 这是什么

Windows 上的**每日无感签到工具**：定时静默启动 WorkBuddy 与 Qoder CN 两个 Electron 客户端 → 通过 CDP（Chrome DevTools Protocol）在客户端自身登录态内领取每日积分 → 优雅退出客户端 → 弹 Windows toast 通知结果。零 npm 依赖（Node 内置 `fetch`/`WebSocket`），客户端全程仅存活约 30–60 秒。

**适用范围（超出范围请直接告知用户不支持，不要尝试适配）：**

- 仅 Windows 10/11 x64；
- 仅 **Qoder CN（中国大陆版，域名 qoder.com.cn）**。国际版 Qoder（qoder.com / qoder.sh）接口域名不同，未适配；
- 签到目标是 **Qoder CN 桌面 App**（`Qoder CN.exe`），**不是** "Qoder CN IDE"（VSCode 内核，`Qoder CN IDE.exe`），两者常同时安装，切勿混淆；
- 两个客户端都必须已由用户**手动登录过且登录态有效**。

## 1. 硬性规则

1. 只允许新增/修改：`config.json`、Windows 任务计划。不得改动 `runner.js`、`apps/*.js`、`lib/*`，除非第 5 节的失效取证证明接口确实变了。
2. **禁止 `npm install` / 新增任何依赖**；禁止 git 操作。
3. 所有文本文件保持 **UTF-8 无 BOM**。
4. `*.ps1` 源码只能包含 **ASCII**（PowerShell 5.1 对无 BOM 脚本按 GBK 解析，中文会导致语法错误）；中文文案只能像 `toast.ps1` 那样通过命令行参数传入。不要向 ps1 中写中文注释或字符串。
5. 杀进程只能按精确 PID（项目已实现 PID 差集 + `taskkill /PID /T`），**禁止按进程名批量结束**。
6. 验证运行前，确认两个客户端**当前未运行**——运行中跳过（`skipped`）是设计行为，不是故障。
7. 任何步骤失败：停下并把该步的命令输出如实告诉用户，不要猜测性重试超过 2 次。

## 2. 安装步骤

### Step 1 环境检查

```powershell
node -v            # 必须 >= v18（需要内置 fetch/WebSocket）；没有则让用户先装 Node.js LTS
where.exe node     # 记录路径，Step 4 注册任务计划用
$PSVersionTable.PSVersion  # 5.1 或 7 均可
```

### Step 2 探测两个客户端的安装路径（注册表权威来源）

```powershell
$roots = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
         'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
         'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
Get-ChildItem $roots -ErrorAction SilentlyContinue | Get-ItemProperty -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match '^(WorkBuddy|Qoder CN)( |$)' -and $_.DisplayName -notmatch 'IDE' } |
  Select-Object DisplayName, DisplayIcon, UninstallString | Format-List
```

路径推导规则：

- **WorkBuddy**：`DisplayIcon` 形如 `D:\xxx\WorkBuddy.exe,0` → 去掉结尾 `,0` 即 exe 全路径；
- **Qoder CN**：`UninstallString` 形如 `"D:\xxx\Uninstall Qoder CN.exe" /currentuser` → 取其引号内路径的**所在目录**，拼 `Qoder CN.exe`。

注册表找不到时的回退：询问用户，或检查 `%LOCALAPPDATA%\Programs\Qoder CN\Qoder CN.exe`、`%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe` 等常见位置。最终必须 `Test-Path` 确认文件真实存在。

### Step 3 检查 CDP 端口占用

默认 9222（WorkBuddy）/ 9223（Qoder）。被占用就换一对空闲端口（如 9322/9323）：

```powershell
Get-NetTCPConnection -LocalPort 9222,9223 -State Listen -ErrorAction SilentlyContinue
```

### Step 4 写 `config.json`（UTF-8 无 BOM）

把探测到的路径与（如有变更的）端口写入，其余字段保持默认：

```json
{
  "scheduleTime": "10:30",
  "readyTimeoutSec": 90,
  "graceCloseSec": 20,
  "hidePollMs": 250,
  "onRunning": "skip",
  "toast": true,
  "apps": {
    "workbuddy": {
      "exePath": "<WorkBuddy.exe 全路径，反斜杠双写>",
      "processName": "WorkBuddy.exe",
      "cdpPort": 9222
    },
    "qoder": {
      "exePath": "<Qoder CN.exe 全路径，反斜杠双写>",
      "processName": "Qoder CN.exe",
      "cdpPort": 9223
    }
  }
}
```

- `scheduleTime` 必须**晚于 10:00**：Qoder 积分每日 10:00（UTC+8）刷新；默认 10:30 已留余量。
- 任务计划只在"用户已登录"时运行（GUI 程序 + toast 需要会话），这是预期行为。

### Step 5 单端实测（必做，两端各一次）

确认客户端未运行，然后在项目目录执行：

```powershell
node runner.js --app=workbuddy
node runner.js --app=qoder
```

预期：客户端静默启动（任务栏可能短暂闪烁 1–2 秒，随后窗口被隐藏）→ 10–40 秒内输出结果 → 客户端自行退出 → 右下角 toast。结束后确认进程清零：

```powershell
Get-Process WorkBuddy,'Qoder CN' -ErrorAction SilentlyContinue   # 应无输出
```

结果语义：

| 输出 | 含义 | 处理 |
|---|---|---|
| `claimed` | 领取成功（未领时才会出现） | 通过 |
| `already` | 今日已领取，未发任何写请求 | 通过 |
| `skipped` | 客户端正在运行 | 让用户退出客户端后重跑 |
| `unauthenticated`（退出码 2） | 登录态失效 | 让用户手动打开对应客户端登录，再重跑 |
| `failed`（退出码 3） | CDP/接口/元素定位失败 | 看 `logs\当天日期.log`，按第 5 节排查 |

同时询问用户：运行期间是否看到了明显的窗口闪现（理想情况几乎无感）。

### Step 6 注册每日任务计划

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-task.ps1
# 自定义时间：-Time 11:00
```

注意：若用户用 nvm 管理 Node，确认任务动作用的是稳定路径（如 `C:\nvm4w\nodejs\node.exe` 这类 symlink 根，而非带版本号的子目录），可用 `Get-ScheduledTask -TaskName AutoCheckin-Daily | Select-Object -ExpandProperty Actions` 核对。

### Step 7 触发任务计划做最终验证

```powershell
Start-ScheduledTask -TaskName 'AutoCheckin-Daily'
# 等约 1 分钟后：
Get-ScheduledTaskInfo -TaskName 'AutoCheckin-Daily' | Select LastRunTime, LastTaskResult, NextRunTime
```

`LastTaskResult = 0` 即通过；明细看 `logs\当天日期.log`。然后向用户说明：

- 每天 10:30 自动执行，电脑当时没开则登录后自动补跑一次；
- **首日（明天）留意 toast 是否为"领取成功 +100"**——安装当天通常两个都已手动领过，只能验证到 `already`，真实领取写路径以首日运行为准；
- 卸载：`uninstall-task.ps1` 后删除目录即可。

## 3. 验证清单（交付给用户前逐项确认）

- [ ] `node runner.js --app=workbuddy` 退出码 0，结果 already/claimed，进程清零
- [ ] `node runner.js --app=qoder` 退出码 0，结果 already/claimed，进程清零
- [ ] 两个客户端正在运行时执行，结果为 skipped 且用户原有进程不受影响
- [ ] 任务计划存在、`NextRunTime` 为明天 10:30、手动触发 `LastTaskResult=0`
- [ ] 未安装任何 npm 依赖（项目内不应出现 node_modules）
- [ ] `config.json` 内路径在本机真实存在

## 4. 常见故障

| 现象 | 排查 |
|---|---|
| `CDP xxxx 在 90000ms 内未就绪` | 端口被占/被杀软拦截；换端口；检查 `--remote-debugging-port` 启动的客户端能否手动访问 `http://127.0.0.1:<端口>/json/version`（注意用 127.0.0.1 且绕过代理） |
| Qoder `等待 CDP target 超时` / 找不到权益中心 | 客户端版本升级改了 UI；按第 5 节重新取证 DOM 定位 |
| WorkBuddy `客户端未返回登录状态` | 先让用户手动打开客户端确认已登录；冷启动会话恢复慢时脚本已内置轮询 |
| 没有 toast | 系统勿扰/专注助手会抑制通知；日志正常即不影响签到 |
| 任务计划不触发 | 仅登录时运行；确认用户登录过、任务状态 Ready、动作的 node 路径有效 |

## 5. 客户端升级导致失效时的重新取证（仅在确实失败时做）

不要凭猜测改代码，用 CDP 实地取证后只更新 `apps/` 下适配器顶部的定位常量：

1. 手动带调试端口启动：`"<exe>" --remote-debugging-port=9222 --remote-allow-origins=*`；
2. 访问 `http://127.0.0.1:9222/json` 查看页面 target（WorkBuddy 的页面是 `file:///...app.asar/renderer/index.html`；Qoder 是 `qoder-cn-app://renderer/...`）；
3. WorkBuddy：在主页面执行 `await window.__wbInvoke('auth:getCheckinStatus')`，若通道改名，在 `resources\app.asar` 中搜索 `billing/meter` 与 IPC 通道名；
4. Qoder：手动打开「用户菜单 → 权益中心」，在 DevTools Network 中确认活动 iframe URL 与 `/sash/api/v1/me/campaigns` 系列接口；**注意鉴权头只在客户端嵌入的 iframe webContents 中存在**，新开标签或顶层导航活动页都会 401，因此必须保留"CDP 可信鼠标点击菜单（`Input.dispatchMouseEvent`，合成 `el.click()` 对 React 无效）→ attach iframe target"这条路径。

## 6. 分发说明（给项目分享者）

分享给他人时**排除以下内容**（个人/机器数据，对别人无用）：`.ai/`、`.idea/`、`logs/`、`node_modules/`。对方拿到后让其 AI 助手阅读本文件即可完成安装。
