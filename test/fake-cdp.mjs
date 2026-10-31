// A fake Chrome behind a fake WebSocket: targets with a URL each, sessions, Runtime.evaluate over a
// tiny page model (location, readyState, a focused field), Input recorded, screencast frames.
export class FakeChrome {
  constructor({ silent = [], redirects = {}, failEvals = 0, passwordAt = [], navError = {}, cookies = {} } = {}) {
    this.cookies = cookies; // origin -> [{name, expires}] (expires in seconds; -1 for a session cookie)
    this.failEvals = failEvals; // the next n Runtime.evaluate calls reject, as during a redirect
    this.passwordAt = new Set(passwordAt); // urls whose page shows a password field
    this.navError = navError; // url -> errorText
    this.targets = new Map();
    this.sessions = new Map();
    this.log = [];
    this.inserted = [];
    this.silent = new Set(silent);
    this.redirects = redirects; // url -> final url (e.g. a login page for a signed-out site)
    this.n = 0;
    const chrome = this;
    this.WebSocket = class {
      constructor(url) { this.url = url; chrome.socket = this; setTimeout(() => this.onopen?.(), 0); }
      send(raw) { chrome.handle(this, JSON.parse(raw)); }
      close() { this.closed = true; }
    };
  }
  reply(ws, msg) { setTimeout(() => ws.onmessage?.({ data: JSON.stringify(msg) }), 0); }
  event(method, params, sessionId) { this.reply(this.socket, { method, params, ...(sessionId ? { sessionId } : {}) }); }
  page(sid) { return this.targets.get(this.sessions.get(sid)); }
  handle(ws, { id, method, params = {}, sessionId }) {
    this.log.push({ method, params, sessionId });
    if (this.silent.has(method)) return;
    const ok = (result = {}) => this.reply(ws, { id, result });
    const err = (message) => this.reply(ws, { id, error: { code: -32000, message } });
    switch (method) {
      case "Target.getTargets": return ok({ targetInfos: [...this.targets].map(([targetId, t]) => ({ targetId, type: "page", url: t.url })) });
      case "Target.createTarget": { const targetId = `T${++this.n}`; const url = this.redirects[params.url] ?? params.url; this.targets.set(targetId, { url, focused: null }); return ok({ targetId }); }
      case "Target.closeTarget": return this.targets.delete(params.targetId) ? ok({ success: true }) : err("No target with given id found");
      case "Target.attachToTarget": { if (!this.targets.has(params.targetId)) return err("No target with given id found"); const s = `S${++this.n}`; this.sessions.set(s, params.targetId); return ok({ sessionId: s }); }
      case "Page.enable": return ok();
      case "Page.navigate": {
        if (this.navError[params.url]) return ok({ frameId: "F", errorText: this.navError[params.url] });
        const p = this.page(sessionId); p.url = this.redirects[params.url] ?? params.url; return ok({ frameId: "F" });
      }
      case "Page.startScreencast": ok(); return this.event("Page.screencastFrame", { data: "AAAA", sessionId: 1, metadata: { deviceWidth: 1440, deviceHeight: 900 } }, sessionId);
      case "Page.screencastFrameAck": case "Page.stopScreencast": return ok();
      case "Page.captureScreenshot": return ok({ data: "AAAA" });
      case "Runtime.evaluate": {
        const p = this.page(sessionId);
        const e = params.expression;
        if (this.failEvals > 0) { this.failEvals--; return err("Execution context was destroyed."); }
        if (e.includes("activeElement")) return ok({ result: { value: { origin: new URL(p.url).origin, framed: !!p.framed, len: p.len || 0 } } });
        if (e.includes("location.href")) return ok({ result: { value: { href: p.url, origin: new URL(p.url).origin, ready: "complete", pw: this.passwordAt.has(p.url) } } });
        if (e.includes("location.origin")) return ok({ result: { value: new URL(p.url).origin } });
        return ok({ result: { value: null } });
      }
      case "Network.getCookies": return ok({ cookies: (params.urls ?? []).flatMap((u) => this.cookies[new URL(u).origin] ?? []) });
      case "Browser.close": this.closedBrowser = true; return ok();
      case "Input.insertText": { this.inserted.push({ text: params.text, sessionId }); const p = this.page(sessionId); if (p) p.len = (p.len || 0) + params.text.length; return ok(); }
      case "Input.dispatchMouseEvent": case "Input.dispatchKeyEvent": return ok();
      default: return err(`'${method}' wasn't found`);
    }
  }
}
