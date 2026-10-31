import test from "node:test";
import assert from "node:assert/strict";
import { createRooms, RoomsError } from "../rooms.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { connectCdp } from "../cdp.mjs";
import { tmpHome, fakeRuntime, fakeFetch } from "./helpers.mjs";
import { FakeChrome } from "./fake-cdp.mjs";

function make(chrome) {
  return createRooms({
    home: tmpHome(), runtime: fakeRuntime(), fetch: fakeFetch(), sleep: async () => {},
    connect: (url) => connectCdp(url, { WebSocket: chrome.WebSocket, timeoutMs: 500 }),
  });
}
const code = (p) => p.then(() => null, (e) => (e instanceof RoomsError ? e.code : e.message));

test("sites are registered per room, origin-normalized, deduplicated", async () => {
  const rooms = make(new FakeChrome());
  await rooms.init("work");
  await rooms.siteAdd("work", "https://app.a.test/acme/x");
  await rooms.siteAdd("work", "https://app.a.test");
  await rooms.siteAdd("work", "https://www.figma.com/files", { signedOut: "/login" });
  assert.deepEqual((await rooms.sites("work")).map((s) => s.origin), ["https://app.a.test", "https://www.figma.com"]);
  assert.equal(await code(rooms.siteAdd("work", "not a url")), "bad_url");
  assert.equal(await code(rooms.siteAdd("work", "http://example.com")), "bad_url"); // https only
});

test("check: a site that lands on its own origin is signed in; a login path or another origin is signed out", async () => {
  const chrome = new FakeChrome({ redirects: {
    "https://www.figma.com/files": "https://www.figma.com/login?cont=x",
    "https://www.c.test/feed/": "https://accounts.google.com/v3/signin",
  } });
  const rooms = make(chrome);
  await rooms.init("work");
  await rooms.up("work");
  await rooms.siteAdd("work", "https://app.a.test/");
  await rooms.siteAdd("work", "https://www.figma.com/files");
  await rooms.siteAdd("work", "https://www.c.test/feed/");
  const r = await rooms.check("work");
  assert.deepEqual(r.map((s) => [s.origin, s.signedIn]), [
    ["https://app.a.test", true],
    ["https://www.figma.com", false],
    ["https://www.c.test", false],
  ]);
  assert.equal(r[1].landed, "https://www.figma.com/login?cont=x");
  assert.equal(chrome.targets.size, 0, "check closes every tab it opened");
  assert.ok(chrome.log.filter((m) => m.method === "Target.createTarget").every((m) => m.params.url === "about:blank"));
  assert.equal(chrome.log.filter((m) => m.method === "Page.navigate").length, 3);
  assert.ok(!chrome.log.some((m) => /^(Network|Storage)\./.test(m.method)), "reads no cookies");
});

test("check on a down room is room_down", async () => {
  const rooms = createRooms({ home: tmpHome(), runtime: fakeRuntime(), fetch: fakeFetch(), sleep: async () => {} });
  await rooms.init("work");
  assert.equal(await code(rooms.check("work")), "room_down");
});

test("down closes Chromium over CDP first, so cookies are flushed to the profile, then stops the container", async () => {
  const chrome = new FakeChrome();
  const runtime = fakeRuntime();
  const order = [];
  const home = tmpHome();
  const rooms = createRooms({
    home, runtime, fetch: fakeFetch(), sleep: async () => {},
    connect: async (url) => { const c = await connectCdp(url, { WebSocket: chrome.WebSocket, timeoutMs: 500 }); const send = c.send; c.send = (m, ...a) => { if (m === "Browser.close") assert.ok(existsSync(join(home, "profiles", "work", ".rooms-stop")), "stop marker must precede Browser.close"); order.push(m); return send(m, ...a); }; return c; },
  });
  await rooms.init("work");
  await rooms.up("work");
  const exec = runtime.exec; runtime.exec = (argv) => { order.push(argv[0]); return exec(argv); };
  await rooms.down("work");
  assert.ok(chrome.closedBrowser);
  assert.ok(order.indexOf("Browser.close") < order.indexOf("stop"), order.join(","));
  const stop = runtime.calls.find((c) => c[0] === "stop");
  assert.deepEqual(stop.slice(0, 3), ["stop", "--time", "15"]);
  await rooms.up("work");
  assert.equal(existsSync(join(home, "profiles", "work", ".rooms-stop")), false, "up clears a prior stop request");
});

test("check: one site's failure (a redirect that drops the page, a load error) never aborts the others", async () => {
  const chrome = new FakeChrome({ failEvals: 2, navError: { "https://down.example.com/": "net::ERR_NAME_NOT_RESOLVED" } });
  const rooms = make(chrome);
  await rooms.init("work");
  await rooms.up("work");
  await rooms.siteAdd("work", "https://app.a.test/");
  await rooms.siteAdd("work", "https://down.example.com/");
  await rooms.siteAdd("work", "https://www.figma.com/files");
  const r = await rooms.check("work");
  assert.deepEqual(r.map((s) => [s.origin, s.signedIn]), [["https://app.a.test", true], ["https://down.example.com", false], ["https://www.figma.com", true]]);
  assert.match(r[1].error, /ERR_NAME_NOT_RESOLVED/);
});

test("check: a page that shows a password field where it landed is signed out, redirect or not", async () => {
  const chrome = new FakeChrome({ passwordAt: ["https://www.d.test/"] });
  const rooms = make(chrome);
  await rooms.init("ig");
  await rooms.up("ig");
  await rooms.siteAdd("ig", "https://www.d.test/");
  const [r] = await rooms.check("ig");
  assert.equal(r.signedIn, false);
  assert.equal(r.why, "password_field");
});

test("down writes nothing the image could restart on: Browser.close comes before stop", async () => {
  const chrome = new FakeChrome();
  const runtime = fakeRuntime();
  const rooms = createRooms({ home: tmpHome(), runtime, fetch: fakeFetch(), sleep: async () => {}, connect: (url) => connectCdp(url, { WebSocket: chrome.WebSocket, timeoutMs: 500 }), awake: { start: () => 1, stop: () => {} } });
  await rooms.init("work");
  await rooms.up("work");
  await rooms.down("work");
  assert.ok(chrome.closedBrowser);
  assert.deepEqual(runtime.calls.at(-2).slice(0, 1), ["stop"]);
});
