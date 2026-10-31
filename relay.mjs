#!/usr/bin/env node
// Token relay in front of Chrome's DevTools server. Chrome binds 127.0.0.1 inside the room, so this
// is what the published port reaches. Every request needs the token, either as the first path
// segment (http://host:port/<token>/json/version, which survives clients that take only a URL) or as
// `Authorization: Bearer <token>`. Without it: 401, and nothing is forwarded. The /json responses'
// ws URLs are rewritten to come back through the relay with the token, so a client that follows
// webSocketDebuggerUrl stays authenticated.
// GET /health needs no token: {ok, protocol}, nothing about the room.
// GET /rooms/activity is answered here: {idleMs} since a client last sent anything, for idle stop.
// Probes and tab listings (/json/*) don't count as use.

import http from "node:http";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TOKEN_RE = /^[0-9a-f]{48}$/;
// What a client can expect of this relay. 1: token auth and ws rewriting. 2: adds /health and
// /rooms/activity.
export const PROTOCOL = 2;

// With tokenFile the token is read from that file (the read-only /rooms mount in a room), so the host
// rotates or revokes it by rewriting the file: the old token stops working at once and connections
// made with it are closed. An unreadable or malformed file lets nothing in.
export async function startRelay({ token, tokenFile, listenHost = "0.0.0.0", listenPort = 9223, upstreamHost = "127.0.0.1", upstreamPort = 9222, now = Date.now }) {
  const read = () => { if (!tokenFile) return token; try { return readFileSync(tokenFile, "utf8").trim(); } catch { return null; } };
  if (!TOKEN_RE.test(read() ?? "")) throw new Error("relay: refusing to start without a 48-hex token");
  const upgraded = new Set();
  let current = read();
  const tokenNow = () => {
    const t = read();
    if (t !== current) { current = t; for (const s of upgraded) s.destroy(); upgraded.clear(); }
    return TOKEN_RE.test(current ?? "") ? current : null;
  };
  const same = (s) => { const t = tokenNow(); if (!t) return false; const want = Buffer.from(t), b = Buffer.from(String(s ?? "")); return b.length === want.length && timingSafeEqual(b, want); };
  const poll = tokenFile ? setInterval(tokenNow, 1000) : null;
  poll?.unref();
  const upstreamAuthority = `${upstreamHost}:${upstreamPort}`;
  let lastUse = now();

  // The path with the token removed, or null when the request isn't authenticated.
  function authorize(req) {
    const m = /^\/([^/?#]+)(\/.*)?$/.exec(req.url ?? "");
    if (m && same(m[1])) return m[2] || "/";
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (bearer && same(bearer[1])) return req.url;
    return null;
  }
  function forwardHeaders(req) {
    const h = { ...req.headers, host: upstreamAuthority };
    delete h.authorization;
    return h;
  }

  const srv = http.createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, protocol: PROTOCOL })); }
    const path = authorize(req);
    if (path == null) { res.writeHead(401, { "content-type": "text/plain" }); return res.end("401: token required\n"); }
    if (path === "/rooms/activity") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ idleMs: now() - lastUse })); }
    if (!/^\/json(\/|$)/.test(path)) lastUse = now();
    const viaToken = !req.headers.authorization;
    const publicAuthority = req.headers.host || `${listenHost}:${srv.address().port}`;
    const up = http.request({ host: upstreamHost, port: upstreamPort, method: req.method, path, headers: forwardHeaders(req) }, (ur) => {
      if (!path.startsWith("/json")) { res.writeHead(ur.statusCode, ur.headers); return ur.pipe(res); }
      const chunks = [];
      ur.on("data", (c) => chunks.push(c));
      ur.on("end", () => {
        const prefix = viaToken ? `/${current}` : "";
        const body = Buffer.concat(chunks).toString("utf8")
          .split(`ws://${upstreamAuthority}/`).join(`ws://${publicAuthority}${prefix}/`)
          .split(`ws=${upstreamAuthority}/`).join(`ws=${publicAuthority}${prefix}/`);
        const headers = { ...ur.headers, "content-length": Buffer.byteLength(body) };
        res.writeHead(ur.statusCode, headers);
        res.end(body);
      });
    });
    up.on("error", (e) => { res.writeHead(502, { "content-type": "text/plain" }); res.end(`502: ${e.message}\n`); });
    req.pipe(up);
  });

  srv.on("upgrade", (req, sock, head) => {
    const path = authorize(req);
    if (path == null) { sock.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
    lastUse = now();
    const up = net.connect(upstreamPort, upstreamHost, () => {
      const h = forwardHeaders(req);
      up.write(`${req.method} ${path} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
      if (head?.length) up.write(head);
      upgraded.add(sock);
      sock.on("close", () => upgraded.delete(sock));
      up.pipe(sock); sock.pipe(up);
      // Attached only once piped: a data listener earlier would start the flow and drop bytes.
      sock.on("data", () => { lastUse = now(); });
    });
    const end = () => { up.destroy(); sock.destroy(); };
    up.on("error", end); sock.on("error", end);
  });

  const open = new Set();
  srv.on("connection", (s) => { open.add(s); s.on("close", () => open.delete(s)); });
  await new Promise((r) => srv.listen(listenPort, listenHost, r));
  return { port: srv.address().port, close: () => { clearInterval(poll); srv.close(); for (const s of open) s.destroy(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await startRelay({ token: process.env.ROOMS_TOKEN, tokenFile: process.env.ROOMS_TOKEN_FILE, listenPort: Number(process.env.ROOMS_RELAY_PORT || 9223), upstreamPort: Number(process.env.ROOMS_CDP_PORT || 9222) });
  console.log(`rooms relay on :${r.port} -> 127.0.0.1:${process.env.ROOMS_CDP_PORT || 9222}`);
}
