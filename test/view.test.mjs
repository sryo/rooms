import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startViewer } from "../view.mjs";
import { connectCdp } from "../cdp.mjs";
import { FakeChrome } from "./fake-cdp.mjs";

const SECRET = "hunter2-correct-horse";

async function setup({ signin, url = "https://app.a.test/acme/application" } = {}) {
  const chrome = new FakeChrome();
  const logs = [];
  // One page already open in the room, as after a sign-in redirect.
  chrome.targets.set("T0", { url });
  const v = await startViewer({
    wsUrl: "ws://room/devtools/browser/x",
    connect: (u) => connectCdp(u, { WebSocket: chrome.WebSocket, timeoutMs: 500 }),
    signin,
    log: (...a) => logs.push(a.join(" ")),
  });
  const post = (path, body, headers = {}) => fetch(v.url + path, { method: "POST", headers: { "content-type": "application/json", origin: v.origin, ...headers }, body: JSON.stringify(body) });
  return { chrome, v, logs, post, close: () => v.close() };
}

test("the page needs the view token, and shows the tab's real origin", async () => {
  const s = await setup({ signin: "https://app.a.test" });
  assert.equal((await fetch(s.v.origin + "/")).status, 404);
  const html = await (await fetch(s.v.url)).text();
  assert.match(html, /app\.a\.test/);
  s.close();
});

test("frames stream over SSE", async () => {
  const s = await setup();
  const res = await fetch(s.v.url + "frames");
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /^data: \{.*"data":"AAAA"/m);
  await reader.cancel();
  s.close();
});

test("a click becomes a trusted press and release at the same point; text goes through insertText", async () => {
  const s = await setup();
  assert.equal((await s.post("input", { type: "click", x: 120, y: 44 })).status, 200);
  const mouse = s.chrome.log.filter((m) => m.method === "Input.dispatchMouseEvent").map((m) => [m.params.type, m.params.x, m.params.y]);
  assert.deepEqual(mouse, [["mousePressed", 120, 44], ["mouseReleased", 120, 44]]);
  await s.post("input", { type: "text", text: "Mateo" });
  assert.equal(s.chrome.inserted.at(-1).text, "Mateo");
  await s.post("input", { type: "key", key: "Enter" });
  assert.ok(s.chrome.log.some((m) => m.method === "Input.dispatchKeyEvent" && m.params.key === "Enter"));
  assert.equal((await s.post("input", { type: "key", key: "rm -rf" })).status, 400);
  s.close();
});

test("a secret goes only to the expected origin, and is never echoed or logged", async () => {
  const s = await setup({ signin: "https://app.a.test" });
  const bad = await s.post("secret", { value: SECRET, expect: "https://evil.example" });
  assert.equal(bad.status, 409);
  assert.equal(s.chrome.inserted.length, 0);
  const good = await s.post("secret", { value: SECRET, expect: "https://app.a.test" });
  assert.equal(good.status, 200);
  assert.ok(!(await good.text()).includes(SECRET));
  assert.equal(s.chrome.inserted.at(-1).text, SECRET);
  assert.ok(!s.logs.join("\n").includes(SECRET));
  s.close();
});

test("when the tab navigated to another origin since the sheet opened, the secret is refused", async () => {
  const s = await setup({ signin: "https://app.a.test" });
  s.chrome.targets.get("T0").url = "https://phish.example/login";
  const r = await s.post("secret", { value: SECRET, expect: "https://app.a.test" });
  assert.equal(r.status, 409);
  assert.equal(s.chrome.inserted.length, 0);
  s.close();
});

test("posts from another origin are refused (no cross-site typing into the room)", async () => {
  const s = await setup();
  const r = await s.post("input", { type: "text", text: "x" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  assert.equal(s.chrome.inserted.length, 0);
  s.close();
});

test("oversized bodies are refused", async () => {
  const s = await setup();
  const r = await s.post("input", { type: "text", text: "x".repeat(20000) });
  assert.equal(r.status, 413);
  s.close();
});

test("a sign-in sheet for a site with no tab yet opens one on the sign-in URL", async () => {
  const s = await setup({ signin: "https://github.com/login", url: "about:blank" });
  const created = s.chrome.log.find((m) => m.method === "Target.createTarget");
  assert.equal(created?.params.url, "https://github.com/login");
  const r = await s.post("secret", { value: SECRET, expect: "https://github.com" });
  assert.equal(r.status, 200);
  s.close();
});

test("a secret is refused when focus is inside an embedded frame, and nothing is typed", async () => {
  const s = await setup({ signin: "https://app.a.test" });
  s.chrome.targets.get("T0").framed = true;
  const r = await s.post("secret", { value: SECRET, expect: "https://app.a.test" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "frame_focus");
  assert.equal(s.chrome.inserted.length, 0);
  s.close();
});

test("a secret that left the focused field unchanged reports not_typed", async () => {
  const s = await setup({ signin: "https://app.a.test" });
  const orig = s.chrome.handle.bind(s.chrome);
  s.chrome.handle = (ws, m) => (m.method === "Input.insertText" ? s.chrome.reply(ws, { id: m.id, result: {} }) : orig(ws, m));
  const r = await s.post("secret", { value: SECRET, expect: "https://app.a.test" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "not_typed");
  s.close();
});

test("the viewer opened as localhost instead of 127.0.0.1 can still drive the room", async () => {
  const s = await setup();
  try {
    const r = await s.post("input", { type: "text", text: "x" }, { origin: s.v.origin.replace("127.0.0.1", "localhost") });
    assert.equal(r.status, 200);
  } finally { s.close(); }
});

test("the viewer says which tab it shows, and with a sign-in sheet, tells once when the tab is past the site's sign-in page", async () => {
  const chrome = new FakeChrome({ redirects: { "https://app.a.test/home": "https://app.a.test/login" } });
  let signedIn = 0;
  const v = await startViewer({
    wsUrl: "ws://room/devtools/browser/x",
    connect: (u) => connectCdp(u, { WebSocket: chrome.WebSocket, timeoutMs: 500 }),
    signin: "https://app.a.test/home",
    signedOut: "(^|/)login([/?#]|$)",
    onSignedIn: () => { signedIn++; },
    pollMs: 10,
  });
  try {
    assert.ok(chrome.targets.has(v.targetId));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(signedIn, 0, "still on the login page");
    chrome.targets.get(v.targetId).url = "https://app.a.test/dashboard";
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(signedIn, 1);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(signedIn, 1, "only once");
  } finally { v.close(); }
});

// fetch can't set Host, so these go through node:http. Only the status and JSON error are read;
// the SSE stream is dropped as soon as its headers arrive.
function raw(v, { method = "GET", path = "", host, origin, body } = {}) {
  const u = new URL(v.url + path);
  return new Promise((resolve, reject) => {
    const headers = { host };
    if (origin) headers.origin = origin;
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers, agent: false }, (res) => {
      if (res.headers["content-type"]?.startsWith("text/event-stream")) { res.destroy(); return resolve({ status: res.statusCode }); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const ROUTES = [
  { method: "GET", path: "" },
  { method: "GET", path: "frames" },
  { method: "GET", path: "origin" },
  { method: "GET", path: "nope" },
  { method: "POST", path: "input", body: { type: "text", text: "x" } },
  { method: "POST", path: "secret", body: { value: SECRET, expect: "https://app.a.test" } },
];

test("a foreign Host (DNS rebinding) is refused on every route, GETs without Origin included", async () => {
  const s = await setup({ signin: "https://app.a.test" });
  const port = new URL(s.v.origin).port;
  try {
    for (const r of ROUTES) {
      for (const origin of [undefined, s.v.origin]) {
        const res = await raw(s.v, { ...r, host: `evil.example:${port}`, origin });
        assert.equal(res.status, 403, `${r.method} ${r.path} origin=${origin}`);
        assert.deepEqual(res.json, { error: "bad_host" });
      }
    }
    for (const host of ["127.0.0.1", "localhost", `127.0.0.1:${Number(port) + 1}`, `localhost.evil.example:${port}`, `[::1]:${port}`]) {
      assert.equal((await raw(s.v, { path: "origin", host })).status, 403, host);
    }
    const tokenless = await new Promise((resolve) => http.get({ hostname: "127.0.0.1", port, path: "/", headers: { host: `evil.example:${port}` }, agent: false }, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.equal(tokenless, 403);
    assert.equal(s.chrome.inserted.length, 0);
  } finally { s.close(); }
});

test("both loopback hosts on the bound port reach every route", async () => {
  const s = await setup({ signin: "https://app.a.test" });
  const port = new URL(s.v.origin).port;
  try {
    for (const name of ["127.0.0.1", "localhost", "LOCALHOST"]) {
      const host = `${name}:${port}`;
      const origin = `http://${name.toLowerCase()}:${port}`;
      for (const r of ROUTES) {
        const res = await raw(s.v, { ...r, host, origin });
        assert.equal(res.status, r.path === "nope" ? 405 : 200, `${host} ${r.method} ${r.path}`);
      }
    }
  } finally { s.close(); }
});

test("the screencast is the room's size, not a fixed 1440x900", async (t) => {
  const chrome = new FakeChrome();
  chrome.targets.set("T0", { url: "https://a.test/" });
  const v = await startViewer({ wsUrl: "ws://room/devtools/browser/x", connect: (u) => connectCdp(u, { WebSocket: chrome.WebSocket, timeoutMs: 500 }), size: "2560x1440" });
  t.after(() => v.close());
  const cast = chrome.log.find((l) => l.method === "Page.startScreencast");
  assert.deepEqual([cast.params.maxWidth, cast.params.maxHeight], [2560, 1440]);
});
