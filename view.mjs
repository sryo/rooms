// The room viewer and sign-in sheet: a page on host loopback that shows a room tab's screencast and
// sends clicks, keys and text back over CDP. With `signin`, it also has a password field whose value
// goes straight to the room's focused field with Input.insertText, only while the tab's origin is
// the one the sheet was opened for. The value is never echoed, stored or logged.
import http from "node:http";
import { randomBytes } from "node:crypto";

const KEYS = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Delete: 46 };
const MAX_BODY = 8192;

export async function startViewer({ wsUrl, connect, signin = null, log = () => {}, port = 0 }) {
  const cdp = await connect(wsUrl);
  const viewToken = randomBytes(16).toString("hex");
  const expected = signin ? new URL(signin).origin : null;

  // The tab to show: the one on the sign-in origin if there is one, else the first page.
  const { targetInfos } = await cdp.send("Target.getTargets");
  const pages = targetInfos.filter((t) => t.type === "page");
  const onExpected = expected && pages.find((t) => { try { return new URL(t.url).origin === expected; } catch { return false; } });
  let target = expected ? onExpected : pages[0];
  if (!target) target = { targetId: (await cdp.send("Target.createTarget", { url: signin ?? "about:blank" })).targetId };
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });

  const clients = new Set();
  let last = null;
  cdp.on("Page.screencastFrame", (p, sid) => {
    if (sid !== sessionId) return;
    cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sessionId).catch(() => {});
    last = `data: ${JSON.stringify({ data: p.data, w: p.metadata?.deviceWidth, h: p.metadata?.deviceHeight })}\n\n`;
    for (const res of clients) res.write(last);
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 }, sessionId);

  const origin = async () => (await cdp.send("Runtime.evaluate", { expression: "location.origin", returnByValue: true }, sessionId)).result.value;
  const mouse = async (x, y) => {
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sessionId);
  };
  const key = async (k) => {
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k] }, sessionId);
  };

  let selfOrigin;
  const srv = http.createServer(async (req, res) => {
    const send = (status, body, type = "application/json") => { res.writeHead(status, { "content-type": type, "cache-control": "no-store" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
    const prefix = `/v/${viewToken}/`;
    if (!req.url.startsWith(prefix)) return send(404, { error: "not_found" });
    const route = req.url.slice(prefix.length);
    try {
      if (req.method === "GET" && route === "") return send(200, page({ expected, origin: await origin().catch(() => "?") }), "text/html; charset=utf-8");
      if (req.method === "GET" && route === "frames") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        clients.add(res);
        if (last) res.write(last);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "GET" && route === "origin") return send(200, { origin: await origin() });
      if (req.method !== "POST") return send(405, { error: "method" });
      if (req.headers.origin !== selfOrigin) return send(403, { error: "cross_origin" });
      const body = await readJson(req);
      if (body === TOO_BIG) return send(413, { error: "too_big" });
      if (route === "input") {
        if (body.type === "click" && Number.isFinite(body.x) && Number.isFinite(body.y)) await mouse(body.x, body.y);
        else if (body.type === "text" && typeof body.text === "string") await cdp.send("Input.insertText", { text: body.text }, sessionId);
        else if (body.type === "key" && KEYS[body.key]) await key(body.key);
        else return send(400, { error: "bad_input" });
        return send(200, { ok: true });
      }
      if (route === "secret") {
        if (!expected) return send(400, { error: "not_a_signin_sheet" });
        const now = await origin();
        if (body.expect !== expected || now !== expected) { log(`rooms view: secret refused, tab is on ${now}, sheet is for ${expected}`); return send(409, { error: "origin_changed", origin: now }); }
        if (typeof body.value !== "string" || !body.value) return send(400, { error: "empty" });
        // The top frame's origin is not enough: focus inside an embedded (possibly cross-origin)
        // frame would take the text. Checked right before the insert, and the focused field must
        // have grown after it.
        const FOCUS = "(() => { const a = document.activeElement; return { origin: location.origin, framed: !!a && /^(IFRAME|FRAME|OBJECT|EMBED)$/.test(a.tagName), len: a && typeof a.value === 'string' ? a.value.length : -1 }; })()";
        const before = (await cdp.send("Runtime.evaluate", { expression: FOCUS, returnByValue: true }, sessionId)).result.value;
        if (before.origin !== expected) return send(409, { error: "origin_changed", origin: before.origin });
        if (before.framed) { log(`rooms view: secret refused, focus is inside an embedded frame on ${expected}`); return send(409, { error: "frame_focus" }); }
        await cdp.send("Input.insertText", { text: body.value }, sessionId);
        const after = (await cdp.send("Runtime.evaluate", { expression: FOCUS, returnByValue: true }, sessionId)).result.value;
        if (!(after.len > before.len)) return send(409, { error: "not_typed" });
        log(`rooms view: sent a secret to ${now}`);
        return send(200, { ok: true });
      }
      return send(404, { error: "not_found" });
    } catch (e) {
      log(`rooms view: ${route}: ${e.message}`);
      return send(500, { error: "cdp" });
    }
  });
  srv.keepAliveTimeout = 1000;
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  selfOrigin = `http://127.0.0.1:${srv.address().port}`;
  return {
    origin: selfOrigin,
    url: `${selfOrigin}/v/${viewToken}/`,
    close: () => {
      for (const res of clients) res.end();
      srv.closeAllConnections?.();
      srv.close();
      cdp.send("Page.stopScreencast", {}, sessionId).catch(() => {}).finally(() => cdp.close());
    },
  };
}

const TOO_BIG = Symbol("too big");
function readJson(req) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n <= MAX_BODY) chunks.push(c); });
    req.on("end", () => { if (n > MAX_BODY) return resolve(TOO_BIG); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); } });
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function page({ expected, origin }) {
  return `<!doctype html><meta charset=utf-8><title>room</title>
<style>
:root{color-scheme:light dark;--bg:#111;--fg:#eee;--warn:#f5a524}
body{margin:0;background:var(--bg);color:var(--fg);font:14px system-ui;display:flex;flex-direction:column;height:100vh}
header{display:flex;gap:12px;align-items:center;padding:8px 12px;border-bottom:1px solid #333}
#origin{font:600 20px ui-monospace,monospace}
#origin.bad{color:var(--warn)}
main{flex:1;display:flex;justify-content:center;align-items:flex-start;overflow:auto}
img{max-width:100%;cursor:crosshair;outline:none}
form{display:flex;gap:6px;align-items:center}
input{font:inherit;padding:4px 6px}
</style>
<header>
  <span>Tab is on</span><span id=origin>${esc(origin)}</span>
  ${expected ? `<form id=sf autocomplete=off><span>Sign-in for <b>${esc(expected)}</b>:</span>
    <input id=sv type=password placeholder="paste password or code" autocomplete=off>
    <button>Send to focused field</button><span id=sm></span></form>` : ""}
</header>
<main><img id=screen tabindex=0 alt="room screen"></main>
<script>
const expected = ${JSON.stringify(expected)};
const img = document.getElementById("screen"); let dev = {w:1440,h:900};
const es = new EventSource("frames");
es.onmessage = (e) => { const f = JSON.parse(e.data); img.src = "data:image/jpeg;base64," + f.data; if (f.w) dev = {w:f.w,h:f.h}; };
const post = (p, b) => fetch(p, {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(b)});
img.addEventListener("click", (e) => { const r = img.getBoundingClientRect(); post("input", {type:"click", x: Math.round((e.clientX - r.left) * dev.w / r.width), y: Math.round((e.clientY - r.top) * dev.h / r.height)}); img.focus(); });
const special = new Set(["Enter","Tab","Backspace","Escape","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Delete"]);
img.addEventListener("keydown", (e) => { if (special.has(e.key)) { e.preventDefault(); post("input", {type:"key", key:e.key}); } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); post("input", {type:"text", text:e.key}); } });
img.addEventListener("paste", (e) => { const t = e.clipboardData.getData("text"); if (t) post("input", {type:"text", text:t}); });
setInterval(async () => { try { const o = (await (await fetch("origin")).json()).origin; const el = document.getElementById("origin"); el.textContent = o; el.className = expected && o !== expected ? "bad" : ""; } catch {} }, 1500);
const sf = document.getElementById("sf");
if (sf) sf.addEventListener("submit", async (e) => { e.preventDefault(); const sv = document.getElementById("sv"), sm = document.getElementById("sm");
  const r = await post("secret", {value: sv.value, expect: expected}); sv.value = "";
  sm.textContent = r.ok ? "sent" : (await r.json()).error === "origin_changed" ? "refused: the tab is not on " + expected : "failed"; });
</script>`;
}
