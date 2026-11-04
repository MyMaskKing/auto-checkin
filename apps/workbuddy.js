// WorkBuddy 适配器：经客户端自带 RPC 桥 __wbInvoke 完成签到
// 通道（asar 内实锤）：
//   auth:getCheckinStatus  → { today_checked_in, streak_days, daily_credit, total_credits, ... } | null
//   auth:claimDailyCheckin → 成功：data 对象（含 credit/streak）；业务失败：{code,msg,requestId}
// 鉴权与图灵风控 token 由主进程自动附加，脚本不接触任何凭据文件。
const { Cdp, sleep } = require('../lib/cdp');

const meta = {
  name: 'WorkBuddy',
  exePath: '',
  processName: 'WorkBuddy.exe',
  cdpPort: 9222,
};

async function invoke(sid, cdp, channel) {
  const expression = `(async () => {
    try {
      const r = await window.__wbInvoke(${JSON.stringify(channel)});
      return JSON.stringify({ ok: true, r: r === undefined ? null : r });
    } catch (e) {
      return JSON.stringify({ ok: false, err: String(e && (e.message || e)) });
    }
  })()`;
  return JSON.parse(await cdp.evalJs(sid, expression));
}

async function signIn(browser, cfg, log, { statusOnly = false } = {}) {
  const page = await browser.waitTarget(
    (t) => t.type === 'page' && /^file:\/\/.*app\.asar\/renderer/.test(t.url || ''),
    45000);
  const sid = await browser.attach(page.targetId);
  await browser.enableRuntime(sid);

  // 冷启动后会话恢复需要时间：状态为 null 时轮询等待（未登录也会是 null，超时按登录态失效处理）
  let status = null;
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const r = await invoke(sid, browser, 'auth:getCheckinStatus');
    if (r.ok && r.r) { status = r.r; break; }
    if (!r.ok) log(`状态查询异常（重试中）：${r.err.slice(0, 120)}`);
    await sleep(1500);
  }
  if (!status) {
    return { status: 'unauthenticated', detail: '客户端未返回登录状态（未登录或会话未恢复），请手动打开 WorkBuddy 确认登录' };
  }

  log(`今日${status.today_checked_in ? '已' : '未'}领取，连续 ${status.streak_days} 天，累计 ${status.total_credits} 分`);
  if (status.today_checked_in) {
    return { status: 'already', detail: `连续 ${status.streak_days} 天，累计 ${status.total_credits} 分` };
  }
  if (statusOnly) {
    return { status: 'already', statusOnly: true, detail: `今日可领 ${status.daily_credit} 分（--status 仅查询）` };
  }

  const r = await invoke(sid, browser, 'auth:claimDailyCheckin');
  if (!r.ok) return { status: 'failed', detail: `领取调用失败：${(r.err || '').slice(0, 150)}` };
  const data = r.r || {};
  if (data.code !== undefined && data.code !== 0) {
    if (data.code === 10001) return { status: 'already', detail: data.msg || '服务端判定今天已签到' };
    return { status: 'failed', detail: `服务端返回 code=${data.code} ${data.msg || ''}`.trim() };
  }
  const gained = data.credit ?? data.today_credit ?? status.daily_credit;
  return { status: 'claimed', gained, detail: `领取成功 +${gained} 分，连续 ${data.streak_days ?? status.streak_days} 天` };
}

module.exports = { meta, signIn };
