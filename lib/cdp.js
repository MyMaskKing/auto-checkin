// 最小 CDP（Chrome DevTools Protocol）客户端：仅依赖 Node 22 内置 fetch / WebSocket
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpGet(port, pathname, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

class Cdp {
  constructor(wsUrl) {
    const u = new URL(wsUrl);
    u.hostname = '127.0.0.1'; // /json 偶尔回显 localhost，统一为 IP，规避代理/解析问题
    this.wsUrl = u.toString();
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.attachedSessions = new Map(); // sessionId -> 收到 attachedToTarget 事件的回调
  }

  static async waitReady(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        const ver = await httpGet(port, '/json/version');
        const cdp = await new Cdp(ver.webSocketDebuggerUrl).open();
        await cdp.send('Target.setDiscoverTargets', { discover: true });
        return cdp;
      } catch (e) {
        lastErr = e;
        await sleep(800);
      }
    }
    throw new Error(`CDP ${port} 在 ${timeoutMs}ms 内未就绪：${lastErr && lastErr.message}`);
  }

  open(handshakeTimeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { this.ws.close(); } catch { /* ignore */ }
        reject(new Error(`WebSocket 握手超时：${this.wsUrl}`));
      }, handshakeTimeoutMs);
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => finish(resolve, this), { once: true });
      this.ws.addEventListener('error', () => finish(reject, new Error(`WebSocket 连接失败：${this.wsUrl}`)), { once: true });
      this.ws.addEventListener('message', (ev) => this.onMessage(ev));
      this.ws.addEventListener('close', () => {
        for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
        this.pending.clear();
      });
    });
  }

  onMessage(ev) {
    const m = JSON.parse(ev.data.toString());
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message || JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method === 'Target.attachedToTarget' && m.params?.sessionId) {
      const cb = this.attachedSessions.get(m.params.sessionId);
      if (cb) { this.attachedSessions.delete(m.params.sessionId); cb(); }
    } else if (m.method) {
      const set = this.handlers.get(m.method);
      if (set) for (const cb of set) {
        try { cb(m.params, m.sessionId); } catch { /* 事件处理异常不影响主流程 */ }
      }
    }
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      // 无超时会在对端收包不回（如 Electron 忽略 Browser.close）时永久挂起整个编排
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时（${timeoutMs}ms）：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(cb);
    return () => this.handlers.get(method).delete(cb);
  }

  async targets() {
    return (await this.send('Target.getTargets')).targetInfos || [];
  }

  async waitTarget(predicate, timeoutMs, intervalMs = 600) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const list = await this.targets();
      const hit = list.find(predicate);
      if (hit) return hit; // targetInfo.attached 表示是否有调试端已挂载，与可用性无关，不过滤
      await sleep(intervalMs);
    }
    throw new Error('等待 CDP target 超时');
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    // 等后端 attachedToTarget 事件，避免立即发消息撞 "Session with given id not found"
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000); // 兜底：事件丢失也不阻塞
      this.attachedSessions.set(sessionId, () => { clearTimeout(timer); resolve(); });
    });
    return sessionId;
  }

  async enableRuntime(sessionId) {
    await this.send('Runtime.enable', {}, sessionId);
  }

  // 在指定 session（attached target）里执行 JS；默认取回传值
  async evalJs(sessionId, expression, { awaitPromise = true, timeout = 20000 } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, timeout,
    }, sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'Runtime.evaluate 异常');
    }
    return r.result.value;
  }

  async closeBrowser() {
    // Electron 客户端可能不响应 Browser.close：短超时失败即可，外层有优雅退出等待与强杀兜底
    try { await this.send('Browser.close', {}, undefined, 5000); } catch { /* 连接随进程退出关闭 */ }
  }

  async minimizeAll() {
    // 尽力而为：最小化浏览器窗口（窗口隐藏另有 Win32 守护兜底）
    try {
      const w = await this.send('Browser.getWindowForTarget', {});
      if (w && w.windowId) {
        await this.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'minimized' } });
      }
    } catch { /* 忽略 */ }
  }

  close() {
    try { this.ws.close(); } catch { /* 已关闭 */ }
  }
}

module.exports = { Cdp, sleep };
