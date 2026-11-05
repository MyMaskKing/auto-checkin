// Qoder CN 适配器：权益中心（growth-page）每日 100 Credits 领取
// 接口（同源 cookie 鉴权，登录态由 Electron session 自动携带）：
//   GET  /sash/api/v1/me/campaigns
//   POST /sash/api/v1/me/campaigns/{campaignId}/claim
// 入口：用户菜单「打开用户菜单」→「权益中心」→ OOPIF https://openapi.qoder.com.cn/growth-page/activity-iframe
const { Cdp, sleep } = require('../lib/cdp');

const GROWTH_RE = /openapi\.qoder\.com\.cn\/growth-page\/activity-iframe/;
const IFRAME_URL = 'https://openapi.qoder.com.cn/growth-page/activity-iframe';

const meta = {
  name: 'Qoder CN',
  exePath: '',
  processName: 'Qoder CN.exe',
  cdpPort: 9223,
};

// ---- 在目标 session 内执行同源 fetch ----
async function fetchIn(cdp, sid, url, options) {
  const expression = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, ${JSON.stringify(options)});
      const t = await r.text();
      return JSON.stringify({ http: r.status, t });
    } catch (e) {
      return JSON.stringify({ http: 0, t: String(e && (e.message || e)) });
    }
  })()`;
  return JSON.parse(await cdp.evalJs(sid, expression));
}

const getCampaigns = (cdp, sid) =>
  fetchIn(cdp, sid, '/sash/api/v1/me/campaigns', { credentials: 'include', headers: { Accept: 'application/json' } });

const postClaim = (cdp, sid, campaignId) =>
  fetchIn(cdp, sid, `/sash/api/v1/me/campaigns/${campaignId}/claim`, {
    method: 'POST', credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: '{}',
  });

function parseCampaigns(resp, log) {
  if (resp.http === 401 || resp.http === 403) {
    return { unauthenticated: true };
  }
  if (resp.http !== 200) {
    log(`campaigns 异常 HTTP ${resp.http}：${(resp.t || '').slice(0, 120)}`);
    return null;
  }
  try {
    const data = JSON.parse(resp.t);
    if (Array.isArray(data.campaigns)) return data;
  } catch { /* 落到 null */ }
  return null;
}

// ---- CDP 可信鼠标点击（合成 el.click() 会被 React 忽略，必须派发输入事件）----
// 定位器在冷启动渲染未完成时可能暂时为空，按 1s 间隔重试到出现
async function clickByEval(cdp, sid, locatorExpr, label, retries = 10) {
  for (let i = 0; i <= retries; i++) {
    const v = await cdp.evalJs(sid, `(() => { ${locatorExpr} })()`);
    if (v) {
      const { x, y } = JSON.parse(v);
      for (const [type, buttons] of [['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0]]) {
        await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons }, sid);
        await sleep(70);
      }
      return true;
    }
    await sleep(1000);
  }
  throw new Error(`未找到${label}（重试 ${retries} 次）`);
}

// 方案 B：驱动主窗口 UI 打开权益中心，等待 growth-page iframe target
async function openViaUi(browser, log) {
  const main = await browser.waitTarget(
    (t) => t.type === 'page' && (t.url || '').startsWith('qoder-cn-app://renderer'),
    20000);
  const sid = await browser.attach(main.targetId);
  await browser.enableRuntime(sid);
  await browser.send('Page.enable', {}, sid);
  await browser.send('Page.bringToFront', {}, sid);
  await sleep(500);

  const menuLocator = `
    const b = [...document.querySelectorAll('[aria-label="打开用户菜单"]')]
      .find(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (!b) return '';
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });`;
  await clickByEval(browser, sid, menuLocator, '用户菜单按钮');
  await sleep(1500);

  const itemLocator = `
    const els = [...document.querySelectorAll('[role=menuitem],[role=menu] *')];
    const el = els.find(e => (e.innerText || '').trim() === '权益中心' && e.getBoundingClientRect().height > 0);
    if (!el) return '';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });`;
  // 冷启动时弹层可能在定位器就绪前自动收起：菜单项连续找不到就重新展开用户菜单，避免一轮重试到底必败
  for (let round = 0; ; round++) {
    try {
      await clickByEval(browser, sid, itemLocator, '「权益中心」菜单项', 3);
      break;
    } catch (e) {
      if (round >= 2) throw e;
      await clickByEval(browser, sid, menuLocator, '用户菜单按钮', 2);
      await sleep(1500);
    }
  }
  log('已点击权益中心，等待活动页加载…');

  const t = await browser.waitTarget((x) => GROWTH_RE.test(x.url || ''), 15000);
  return t.targetId;
}

// 从一个同源 session 读取活动数据；result.campaigns 非空即成功
async function readCampaigns(browser, sid, log, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    if (i > 0) await sleep(1000);
    const c = parseCampaigns(await getCampaigns(browser, sid), log);
    if (c?.unauthenticated) return { unauthenticated: true };
    if (c) return { campaigns: c };
  }
  return null;
}

// 方案：客户端自带弹窗已有活动页就直接用；否则模拟点击「用户菜单 → 权益中心」打开 OOPIF。
// 说明：Target.createTarget 在 Electron 下返回 Not supported；主窗口顶层导航到活动页会 401
// （Authorization 头仅在主应用嵌入的 iframe webContents 中由客户端注入），故只能走 UI 入口。
async function attachGrowthSession(browser, log) {
  // 0) 客户端自带弹窗已加载活动页
  const existed = (await browser.targets()).find(
    (x) => (x.type === 'iframe' || x.type === 'page') && GROWTH_RE.test(x.url || ''));
  if (existed) {
    const sid = await browser.attach(existed.targetId);
    await browser.enableRuntime(sid);
    const r = await readCampaigns(browser, sid, log, 5);
    if (r) return { sid, ...r };
  }

  // 1) 模拟点击用户菜单 → 权益中心，等待 OOPIF 出现
  const targetId = await openViaUi(browser, log);
  const sid = await browser.attach(targetId);
  await browser.enableRuntime(sid);
  const r = await readCampaigns(browser, sid, log, 8);
  if (r?.unauthenticated) return { sid, unauthenticated: true };
  if (r) return { sid, ...r };
  throw new Error('权益中心活动数据加载失败');
}

async function signIn(browser, cfg, log, { statusOnly = false } = {}) {
  const { sid, campaigns, unauthenticated } = await attachGrowthSession(browser, log);
  if (unauthenticated) {
    return { status: 'unauthenticated', detail: 'Qoder 登录态失效，请手动打开 Qoder CN 重新登录' };
  }

  const claimable = (campaigns.campaigns || []).filter(
    (c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus !== 'CLAIMED');
  const daily = (campaigns.campaigns || []).find((c) => c.actionType === 'CLAIM_BENEFIT');
  const title = daily?.placements?.[0]?.content?.zh?.title || '每日积分';

  if (claimable.length === 0) {
    log(`${title}：今日已领取`);
    return { status: 'already', detail: `${title}：今日已领取` };
  }
  if (statusOnly) {
    return { status: 'already', statusOnly: true, detail: `${title}：今日可领 ${claimable.map((c) => c.benefit?.amount).join('/')} Credits（--status 仅查询）` };
  }

  // 先查后领：逐个活动只发一次 claim
  const results = [];
  for (const c of claimable) {
    const name = c.placements?.[0]?.content?.zh?.title || c.campaignKey;
    const resp = await postClaim(browser, sid, c.campaignId);
    results.push({ id: c.campaignId, name, http: resp.http, t: resp.t });
    log(`领取请求 ${c.campaignKey} → HTTP ${resp.http}`);
  }

  // 二次核对：以服务端最新 claimStatus 为准
  await sleep(1200);
  const after = parseCampaigns(await getCampaigns(browser, sid), log);
  if (!after) {
    return { status: 'failed', detail: '领取后状态核对失败，请在客户端「权益中心」确认' };
  }
  const claimedNow = [];
  for (const c of after.campaigns || []) {
    if (c.actionType !== 'CLAIM_BENEFIT') continue;
    const before = results.find((r) => r.id === c.campaignId);
    if (before && c.claimStatus === 'CLAIMED') claimedNow.push(c);
  }
  if (claimedNow.length === 0) {
    const first = results[0];
    return { status: 'failed', detail: `领取未被确认（HTTP ${first.http}：${(first.t || '').slice(0, 100)}）` };
  }
  const gained = claimedNow.reduce((s, c) => s + (c.benefit?.amount || 0), 0);
  return { status: 'claimed', gained, detail: `${claimedNow.map((c) => c.placements?.[0]?.content?.zh?.title || '活动').join('、')}：+${gained} Credits` };
}

module.exports = { meta, signIn };
