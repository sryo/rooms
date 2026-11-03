import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRooms, main } from "../rooms.mjs";
import { acquireFileLock } from "../locks.mjs";
import { tmpHome, fakeRuntime, fakeFetch } from "./helpers.mjs";

// The fake runtime plus images: tag -> {digest, version}; each container remembers its image's digest.
function imageRuntime(version = "156.0.8078.73") {
  const rt = fakeRuntime(), exec = rt.exec.bind(rt);
  const images = new Map([["rooms-chrome:latest", { digest: "sha256:v1", version }]]);
  const ran = new Map();
  let builds = 0;
  rt.images = images;
  rt.next = { version, fails: false };
  rt.stops = 0;
  rt.exec = (argv) => { const r = exec(argv); if (argv[0] === "run" && r.code === 0) ran.set(argv[argv.indexOf("--name") + 1], images.get(argv.at(-1))?.digest); return r; };
  rt.imageInfo = (tag) => (images.has(tag) ? { digest: images.get(tag).digest, built: "2026-11-01T00:00:00Z" } : null);
  rt.imageVersion = (tag) => images.get(tag).version;
  rt.containerImage = (cname) => ran.get(cname) ?? null;
  rt.build = (tag) => { builds++; if (rt.next.fails) return { code: 1, stderr: "apt failed" }; images.set(tag, { digest: `sha256:b${builds}`, version: rt.next.version }); return { code: 0, stderr: "" }; };
  rt.tag = (from, to) => images.set(to, images.get(from));
  rt.removeImage = (tag) => images.delete(tag);
  rt.builderStop = () => { rt.stops++; };
  rt.builds = () => builds;
  return rt;
}

const DAY_MS = 24 * 3600000;
// A build context holding the files the image is made from.
const context = () => {
  const dir = tmpHome();
  mkdirSync(join(dir, "image"));
  for (const f of ["image/Dockerfile", "image/entrypoint.sh", "image/policies.json", "relay.mjs"]) writeFileSync(join(dir, f), f);
  return dir;
};
const setup = ({ idle = 0 } = {}) => {
  const home = tmpHome(), runtime = imageRuntime(), notes = [], ctx = context();
  let t = Date.parse("2026-11-01T00:00:00Z");
  const base = fakeFetch();
  const fetch = async (url, o) => (url.endsWith("/rooms/activity") ? { ok: true, json: async () => ({ idleMs: idle }) } : url.endsWith("/json/list") ? { ok: true, json: async () => [{ id: "T1", type: "page" }] } : base(url, o));
  const rooms = createRooms({ home, runtime, fetch, sleep: async () => {}, physicalMemory: 64 * 2 ** 30, now: () => t, notify: (a, b) => notes.push(b), cloneFile: (a, b) => writeFileSync(b, ""), buildContext: ctx });
  return { home, runtime, rooms, notes, ctx, advance: (ms) => { t += ms; }, setIdle: (ms) => { idle = ms; } };
};

test("update builds at most once a day and promotes a build when its Chromium or the image's files changed", async () => {
  const { runtime, rooms, advance, ctx } = setup();
  assert.equal((await rooms.update()).state, "promoted", "latest wasn't built from these files yet");
  assert.equal((await rooms.update()).state, "not_due");
  advance(DAY_MS);
  assert.equal((await rooms.update()).state, "current", "same Chromium, same files: latest is left alone");
  assert.equal(runtime.images.has("rooms-chrome:candidate"), false);
  advance(DAY_MS);
  runtime.next.version = "156.0.8078.80";
  const u = await rooms.update();
  assert.deepEqual([u.state, u.from, u.to], ["promoted", "156.0.8078.73", "156.0.8078.80"]);
  const before = runtime.images.get("rooms-chrome:latest");
  assert.equal(runtime.images.get("rooms-chrome:previous").version, "156.0.8078.73");
  advance(DAY_MS);
  writeFileSync(join(ctx, "image", "entrypoint.sh"), "changed\n");
  assert.equal((await rooms.update()).state, "promoted", "the image's own files changed");
  assert.notEqual(runtime.images.get("rooms-chrome:latest").digest, before.digest);
  assert.equal(runtime.builds(), 4);
  assert.equal(runtime.stops, 4, "the builder VM is stopped after every build");
});

test("a failed build leaves latest alone, stops the builder, and tells the user once", async () => {
  const { runtime, rooms, notes, advance } = setup();
  runtime.next.fails = true;
  assert.equal((await rooms.update()).state, "build_failed");
  advance(DAY_MS);
  await rooms.update();
  assert.equal(runtime.images.get("rooms-chrome:latest").digest, "sha256:v1");
  assert.equal(runtime.stops, 2);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /apt failed/);
  runtime.next.fails = false;
  advance(DAY_MS);
  await rooms.update();
  runtime.next.fails = true;
  advance(DAY_MS);
  await rooms.update();
  assert.equal(notes.length, 2, "told again after it had recovered");
});

test("a second update while one runs steps aside", async () => {
  const { home, rooms } = setup();
  const lock = await acquireFileLock(join(home, "run", "update.lock.sqlite"));
  try { assert.equal((await rooms.update()).state, "busy"); }
  finally { lock.release(); }
});

test("a room moves to a new build only once nothing has used it for an hour, and keeps a checkpoint", async () => {
  const { runtime, rooms, setIdle } = setup({ idle: 10 * 60000 });
  await rooms.init("work");
  await rooms.up("work");
  runtime.images.set("rooms-chrome:latest", { digest: "sha256:v2", version: "156.0.8078.80" });
  assert.equal((await rooms.heartbeat("work")).state, "up", "in use: left alone");
  assert.equal(runtime.containerImage("rooms-work"), "sha256:v1");
  setIdle(61 * 60000);
  const r = await rooms.heartbeat("work");
  assert.equal(r.state, "updated");
  assert.equal(runtime.containerImage("rooms-work"), "sha256:v2");
  assert.ok((await rooms.checkpoints("work")).some((c) => c.id.startsWith("pre-update-")));
  assert.ok((await rooms.events("work")).some((e) => e.event === "updated"));
});

test("a room isn't moved while the user has one of its tabs in the viewer", async () => {
  const { runtime, rooms } = setup({ idle: 2 * 3600000 });
  await rooms.init("work");
  await rooms.up("work");
  const release = await rooms.holdTab("work", "T1");
  runtime.images.set("rooms-chrome:latest", { digest: "sha256:v2", version: "156.0.8078.80" });
  assert.equal((await rooms.heartbeat("work")).state, "up");
  assert.equal(runtime.containerImage("rooms-work"), "sha256:v1");
  release();
});

test("a room whose sites sign out on the new build goes back to its checkpoint and the previous image, once", async () => {
  const { runtime, rooms, notes } = setup({ idle: 2 * 3600000 });
  await rooms.init("work");
  await rooms.siteAdd("work", "https://a.test/");
  await rooms.up("work");
  await rooms.logEvent("work", "check", { sites: { "https://a.test": "signed_in" } });
  runtime.tag("rooms-chrome:latest", "rooms-chrome:previous");
  runtime.images.set("rooms-chrome:latest", { digest: "sha256:v2", version: "156.0.8078.80" });
  let restored = null;
  const restore = rooms.restore.bind(rooms);
  rooms.restore = async (n, id) => { restored = id; return restore(n, id); };
  rooms.check = async () => [{ origin: "https://a.test", state: "signed_out" }];
  const r = await rooms.heartbeat("work");
  assert.equal(r.state, "rolled_back");
  assert.match(restored, /^pre-update-/);
  assert.equal(runtime.containerImage("rooms-work"), "sha256:v1");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /work.*a\.test/);
  assert.equal((await rooms.heartbeat("work")).state, "up", "the same build isn't tried again");
  assert.equal(runtime.containerImage("rooms-work"), "sha256:v1");
});

test("only the two newest pre-update checkpoints are kept", async () => {
  const { runtime, rooms, advance } = setup({ idle: 2 * 3600000 });
  await rooms.init("work");
  await rooms.up("work");
  for (const n of [2, 3, 4]) {
    advance(3600000);
    runtime.images.set("rooms-chrome:latest", { digest: `sha256:v${n}`, version: `156.0.8078.${80 + n}` });
    assert.equal((await rooms.heartbeat("work")).state, "updated");
  }
  const ids = (await rooms.checkpoints("work")).filter((c) => c.id.startsWith("pre-update-")).map((c) => c.id);
  assert.equal(ids.length, 2);
});

test("rooms update builds now, whenever the last build was", async () => {
  const calls = [], lines = [];
  const rooms = { update: async (o) => { calls.push(o); return { state: "current", version: "156.0.8078.73" }; } };
  assert.equal(await main(["update", "--json"], rooms, (l) => lines.push(l)), 0);
  assert.deepEqual(calls, [{ force: true }]);
  assert.equal(JSON.parse(lines[0]).state, "current");
});
