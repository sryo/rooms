#!/usr/bin/env node
// Token relay in front of Chrome's DevTools server. Chrome binds 127.0.0.1 inside the room, so this
// is what the published port reaches. Every request needs the token, either as the first path
// segment (http://host:port/<token>/json/version, which survives clients that take only a URL) or as
// `Authorization: Bearer <token>`. Without it: 401, and nothing is forwarded. The /json responses'
// ws URLs are rewritten to come back through the relay with the token, so a client that follows
// webSocketDebuggerUrl stays authenticated.

import http from "node:http";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const TOKEN_RE = /^[0-9a-f]{48}$/;

export async function startRelay({ token, listenHost = "0.0.0.0", listenPort = 9223, upstreamHost = "127.0.0.1", upstreamPort = 9222 }) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new Error("relay: refusing to start without a 48-hex token");
  const want = Buffer.from(token);
  const same = (s) => { const b = Buffer.from(String(s ?? "")); return b.length === want.length && timingSafeEqual(b, want); };
  const upstreamAuthority = `${upstreamHost}:${upstreamPort}`;

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
    const path = authorize(req);
    if (path == null) { res.writeHead(401, { "content-type": "text/plain" }); return res.end("401: token required\n"); }
    const viaToken = !req.headers.authorization;
    const publicAuthority = req.headers.host || `${listenHost}:${srv.address().port}`;
    const up = http.request({ host: upstreamHost, port: upstreamPort, method: req.method, path, headers: forwardHeaders(req) }, (ur) => {
      if (!path.startsWith("/json")) { res.writeHead(ur.statusCode, ur.headers); return ur.pipe(res); }
      const chunks = [];
      ur.on("data", (c) => chunks.push(c));
      ur.on("end", () => {
        const prefix = viaToken ? `/${token}` : "";
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
    const up = net.connect(upstreamPort, upstreamHost, () => {
      const h = forwardHeaders(req);
      up.write(`${req.method} ${path} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    const end = () => { up.destroy(); sock.destroy(); };
    up.on("error", end); sock.on("error", end);
  });

  const open = new Set();
  srv.on("connection", (s) => { open.add(s); s.on("close", () => open.delete(s)); });
  await new Promise((r) => srv.listen(listenPort, listenHost, r));
  return { port: srv.address().port, close: () => { srv.close(); for (const s of open) s.destroy(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await startRelay({ token: process.env.ROOMS_TOKEN, listenPort: Number(process.env.ROOMS_RELAY_PORT || 9223), upstreamPort: Number(process.env.ROOMS_CDP_PORT || 9222) });
  console.log(`rooms relay on :${r.port} -> 127.0.0.1:${process.env.ROOMS_CDP_PORT || 9222}`);
}
