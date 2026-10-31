import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { startRelay } from "../relay.mjs";

const TOKEN = "a".repeat(48);
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

// A stand-in for Chrome's DevTools server: /json/* answers with ws URLs built from Host, as Chrome does;
// an upgrade on /devtools/* answers 101 and then echoes bytes.
async function fakeChrome() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, auth: req.headers.authorization });
    if (req.url === "/json/version") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ Browser: "Chromium/150.0", webSocketDebuggerUrl: `ws://${req.headers.host}/devtools/browser/abc` }));
    }
    if (req.url === "/json/list") {
      return res.end(JSON.stringify([{ id: "T1", type: "page", webSocketDebuggerUrl: `ws://${req.headers.host}/devtools/page/T1`, devtoolsFrontendUrl: `/devtools/inspector.html?ws=${req.headers.host}/devtools/page/T1` }]));
    }
    res.statusCode = 404; res.end();
  });
  srv.on("upgrade", (req, sock) => {
    seen.push({ url: req.url, host: req.headers.host, upgrade: true, auth: req.headers.authorization });
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    sock.on("data", (d) => sock.write(d));
  });
  const open = new Set();
  srv.on("connection", (s) => { open.add(s); s.on("close", () => open.delete(s)); });
  const port = await listen(srv);
  return { port, seen, close: () => { srv.close(); for (const s of open) s.destroy(); } };
}

async function setup() {
  const chrome = await fakeChrome();
  const relay = await startRelay({ token: TOKEN, listenHost: "127.0.0.1", listenPort: 0, upstreamPort: chrome.port });
  const base = `http://127.0.0.1:${relay.port}`;
  return { chrome, relay, base, close: () => { relay.close(); chrome.close(); } };
}

test("no token: 401, and nothing reaches Chrome", async () => {
  const s = await setup();
  for (const path of ["/json/version", "/json/list", "/devtools/browser/abc", `/${"b".repeat(48)}/json/version`]) {
    const r = await fetch(s.base + path);
    assert.equal(r.status, 401, path);
  }
  assert.equal(s.chrome.seen.length, 0);
  s.close();
});

test("token in the path: /json/version is proxied and its ws URL is rewritten to come back through the relay", async () => {
  const s = await setup();
  const j = await (await fetch(`${s.base}/${TOKEN}/json/version`)).json();
  assert.equal(j.Browser, "Chromium/150.0");
  assert.equal(j.webSocketDebuggerUrl, `ws://127.0.0.1:${s.relay.port}/${TOKEN}/devtools/browser/abc`);
  assert.equal(s.chrome.seen[0].url, "/json/version");
  assert.equal(s.chrome.seen[0].host, `127.0.0.1:${s.chrome.port}`, "Chrome sees a loopback Host, so it accepts the request");
  const list = await (await fetch(`${s.base}/${TOKEN}/json/list`)).json();
  assert.equal(list[0].webSocketDebuggerUrl, `ws://127.0.0.1:${s.relay.port}/${TOKEN}/devtools/page/T1`);
  assert.ok(!list[0].devtoolsFrontendUrl.includes(`127.0.0.1:${s.chrome.port}`));
  s.close();
});

test("a Bearer header works too, and the header is not forwarded to Chrome", async () => {
  const s = await setup();
  const r = await fetch(`${s.base}/json/version`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200);
  assert.equal(s.chrome.seen[0].auth, undefined);
  s.close();
});

function rawUpgrade(port, path, extra = "") {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
    });
    let buf = "";
    sock.on("data", (d) => { buf += d; if (buf.includes("\r\n\r\n")) resolve({ sock, head: buf }); });
    sock.on("close", () => resolve({ sock, head: buf }));
  });
}

test("websocket upgrade with the path token reaches Chrome on the stripped path, then bytes flow both ways", async () => {
  const s = await setup();
  const { sock, head } = await rawUpgrade(s.relay.port, `/${TOKEN}/devtools/page/T1`);
  assert.match(head, /^HTTP\/1\.1 101/);
  const up = s.chrome.seen.find((x) => x.upgrade);
  assert.equal(up.url, "/devtools/page/T1");
  assert.equal(up.host, `127.0.0.1:${s.chrome.port}`);
  const echoed = await new Promise((r) => { sock.once("data", (d) => r(String(d))); sock.write("ping-bytes"); });
  assert.equal(echoed, "ping-bytes");
  sock.destroy();
  s.close();
});

test("websocket upgrade without the token is refused and Chrome never sees it", async () => {
  const s = await setup();
  const { head } = await rawUpgrade(s.relay.port, "/devtools/page/T1");
  assert.match(head, /^HTTP\/1\.1 401/);
  assert.ok(!s.chrome.seen.some((x) => x.upgrade));
  s.close();
});

test("the relay refuses to start without a 48-hex token", async () => {
  await assert.rejects(() => startRelay({ token: "", listenPort: 0, upstreamPort: 1 }), /token/);
  await assert.rejects(() => startRelay({ token: "short", listenPort: 0, upstreamPort: 1 }), /token/);
});
