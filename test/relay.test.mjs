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

test("activity: how long since a client last sent anything, answered by the relay itself and only with the token", async () => {
  let now = 1000;
  const chrome = await fakeChrome();
  const relay = await startRelay({ token: TOKEN, listenHost: "127.0.0.1", listenPort: 0, upstreamPort: chrome.port, now: () => now });
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    assert.equal((await fetch(`${base}/rooms/activity`)).status, 401);
    now = 5000;
    await fetch(`${base}/${TOKEN}/json/version`); // a health probe isn't use
    await fetch(`${base}/${TOKEN}/json/list`); // nor is listing the tabs
    assert.deepEqual(await (await fetch(`${base}/${TOKEN}/rooms/activity`)).json(), { idleMs: 4000 });
    assert.ok(!chrome.seen.some((s) => s.url.includes("activity")), "answered by the relay, not forwarded");
    const sock = net.connect(relay.port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    sock.write(`GET /${TOKEN}/devtools/browser/abc HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    await new Promise((r) => sock.once("data", r));
    now = 9000;
    sock.write("frame");
    await new Promise((r) => sock.once("data", r));
    now = 9500;
    assert.deepEqual(await (await fetch(`${base}/${TOKEN}/rooms/activity`)).json(), { idleMs: 500 });
    sock.destroy();
  } finally { relay.close(); chrome.close(); }
});

test("/health needs no token and says only that the relay is up and which protocol it speaks", async () => {
  const s = await setup();
  try {
    const r = await fetch(`${s.base}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, protocol: 2 });
    assert.ok(!s.chrome.seen.some((x) => x.url.includes("health")));
  } finally { s.close(); }
});

test("with a token file, rewriting the file rotates the token: the old one stops working and its open connections close", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "relay-")), "token");
  writeFileSync(file, TOKEN + "\n");
  const chrome = await fakeChrome();
  const relay = await startRelay({ tokenFile: file, listenHost: "127.0.0.1", listenPort: 0, upstreamPort: chrome.port });
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    assert.equal((await fetch(`${base}/${TOKEN}/json/version`)).status, 200);
    const { sock, head } = await rawUpgrade(relay.port, `/${TOKEN}/devtools/page/T1`);
    assert.match(head, /^HTTP\/1\.1 101/);
    const closed = new Promise((r) => sock.once("close", r));
    const next = "b".repeat(48);
    writeFileSync(file, next + "\n");
    assert.equal((await fetch(`${base}/${TOKEN}/json/version`)).status, 401);
    assert.equal((await fetch(`${base}/${next}/json/version`)).status, 200);
    await closed;
  } finally { relay.close(); chrome.close(); }
});
