import test from "node:test";
import assert from "node:assert/strict";
import { connectCdp, CDP_ALLOWED } from "../cdp.mjs";
import { FakeChrome } from "./fake-cdp.mjs";

test("allowlist: no cookie, storage or focus-taking methods", () => {
  for (const m of CDP_ALLOWED) assert.doesNotMatch(m, /^(Network|Storage)\.|bringToFront|activateTarget/);
});

test("send resolves with the result; a CDP error rejects", async () => {
  const chrome = new FakeChrome();
  const c = await connectCdp("ws://x", { WebSocket: chrome.WebSocket });
  const t = await c.send("Target.createTarget", { url: "https://a.test/" });
  assert.ok(t.targetId);
  await assert.rejects(() => c.send("Target.closeTarget", { targetId: "nope" }), /No target/);
  c.close();
});

test("a method outside the allowlist throws before anything is sent", async () => {
  const chrome = new FakeChrome();
  const c = await connectCdp("ws://x", { WebSocket: chrome.WebSocket });
  assert.throws(() => c.send("Network.getAllCookies"), /not allowed/);
  assert.throws(() => c.send("Page.bringToFront"), /not allowed/);
  assert.ok(!chrome.log.some((m) => m.method.startsWith("Network")));
  c.close();
});

test("events reach listeners, per session", async () => {
  const chrome = new FakeChrome();
  const c = await connectCdp("ws://x", { WebSocket: chrome.WebSocket });
  const { targetId } = await c.send("Target.createTarget", { url: "https://a.test/" });
  const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
  const got = new Promise((r) => c.on("Page.screencastFrame", (p, sid) => r({ p, sid })));
  await c.send("Page.startScreencast", { format: "jpeg" }, sessionId);
  const { p, sid } = await got;
  assert.equal(sid, sessionId);
  assert.ok(p.data);
  c.close();
});

test("a call with no answer times out", async () => {
  const chrome = new FakeChrome({ silent: ["Runtime.evaluate"] });
  const c = await connectCdp("ws://x", { WebSocket: chrome.WebSocket, timeoutMs: 30 });
  await assert.rejects(() => c.send("Runtime.evaluate", { expression: "1" }), /timeout/);
  c.close();
});
