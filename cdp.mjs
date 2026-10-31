// Minimal CDP client over Node's global WebSocket, limited to an allowlist: nothing that reads
// cookies or storage, nothing that brings a window to the front.
export const CDP_ALLOWED = new Set([
  "Target.getTargets", "Target.createTarget", "Target.attachToTarget", "Target.closeTarget",
  "Page.enable", "Page.navigate", "Page.captureScreenshot",
  "Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck",
  "Runtime.evaluate",
  "Browser.close",
  "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText",
]);

export async function connectCdp(wsUrl, { WebSocket = globalThis.WebSocket, timeoutMs = 30000 } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(new Error(`cdp: can't connect to ${wsUrl.replace(/\/[0-9a-f]{48}\//, "/<token>/")}: ${e?.message ?? "error"}`));
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(typeof m.data === "string" ? m.data : String(m.data));
    if (msg.id != null) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id); clearTimeout(p.t);
      msg.error ? p.rej(new Error(`${p.method}: ${msg.error.message}`)) : p.res(msg.result);
    } else for (const fn of listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
  };
  ws.onclose = () => { for (const p of pending.values()) { clearTimeout(p.t); p.rej(new Error(`${p.method}: connection closed`)); } pending.clear(); };
  return {
    send(method, params = {}, sessionId) {
      if (!CDP_ALLOWED.has(method)) throw new Error(`cdp: ${method} is not allowed`);
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((res, rej) => {
        const t = setTimeout(() => { pending.delete(i); rej(new Error(`${method}: timeout after ${timeoutMs} ms`)); }, timeoutMs);
        pending.set(i, { res, rej, t, method });
      });
    },
    on(method, fn) { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); },
    close() { ws.close(); },
  };
}

// The browser-level ws URL for a room endpoint (http://127.0.0.1:<port>/<token>).
export async function browserWsUrl(endpoint, fetch = globalThis.fetch) {
  const r = await fetch(`${endpoint}/json/version`);
  if (!r.ok) throw new Error(`cdp: /json/version answered ${r.status}`);
  return (await r.json()).webSocketDebuggerUrl;
}
