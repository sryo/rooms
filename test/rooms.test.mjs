import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, readFileSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createRooms, RoomsError } from "../rooms.mjs";
import { tmpHome, fakeRuntime, fakeFetch } from "./helpers.mjs";

const make = (opts = {}) => {
  const home = opts.home ?? tmpHome();
  const runtime = opts.runtime ?? fakeRuntime();
  const fetch = opts.fetch ?? fakeFetch();
  const rooms = createRooms({ home, runtime, fetch, sleep: async () => {}, image: "rooms-chrome:test", portBase: 9300 });
  return { home, runtime, fetch, rooms };
};
const code = (fn) => fn().then(() => null, (e) => (e instanceof RoomsError ? e.code : `not RoomsError: ${e.message}`));

// ---------- M1: registry ----------
test("init writes one room with a fixed profile path, a loopback port and a token, mode 0600", async () => {
  const { home, rooms } = make();
  const r = await rooms.init("work");
  assert.equal(r.name, "work");
  assert.equal(r.profile, join(home, "profiles", "work"));
  assert.equal(r.cdp.host, "127.0.0.1");
  assert.equal(r.cdp.port, 9300);
  assert.match(r.cdp.token, /^[0-9a-f]{48}$/);
  assert.ok(existsSync(r.profile));
  const file = join(home, "rooms.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).rooms.work, r);
});

test("names are validated and unique; ports don't collide", async () => {
  const { rooms } = make();
  assert.equal(await code(() => rooms.init("Bad Name")), "bad_name");
  assert.equal(await code(() => rooms.init("../x")), "bad_name");
  const a = await rooms.init("a");
  const b = await rooms.init("b");
  assert.notEqual(a.cdp.port, b.cdp.port);
  assert.notEqual(a.cdp.token, b.cdp.token);
  assert.equal(await code(() => rooms.init("a")), "room_exists");
});

test("the profile path can't be overridden: it is always <home>/profiles/<name>", async () => {
  const { home, rooms } = make();
  const r = await rooms.init("x", { profile: "/tmp/elsewhere" });
  assert.equal(r.profile, join(home, "profiles", "x"));
});

// ---------- M2: runtime argv ----------
test("up runs the container bound to host loopback only, with the profile mounted and the token in an env file", async () => {
  const { home, runtime, rooms } = make();
  const r = await rooms.init("work");
  await rooms.up("work");
  const run = runtime.calls.find((c) => c[0] === "run");
  const at = (flag) => run[run.indexOf(flag) + 1];
  assert.equal(at("--name"), "rooms-work");
  assert.equal(at("--publish"), `127.0.0.1:${r.cdp.port}:9223`);
  assert.equal(at("--volume"), `${r.profile}:/profile`);
  assert.ok(run.includes(`${join(home, "downloads", "work")}:/downloads`));
  assert.ok(existsSync(join(home, "downloads", "work")));
  assert.equal(at("--shm-size"), "2G");
  assert.equal(at("--memory"), "4G");
  assert.ok(run.includes("--detach"));
  assert.ok(!run.includes("--rm"), "a room's container is never auto-removed");
  assert.equal(run.at(-1), "rooms-chrome:test");
  assert.ok(!run.join(" ").includes(r.cdp.token), "token never on the command line");
  const envFile = at("--env-file");
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.match(readFileSync(envFile, "utf8"), new RegExp(`^ROOMS_TOKEN=${r.cdp.token}$`, "m"));
  assert.ok(envFile.startsWith(home));
});

test("shared memory is half the room's RAM, capped at 2 GiB", async () => {
  for (const [memory, expected] of [["2G", "1G"], ["3G", "1536M"], ["8G", "2G"]]) {
    const home = tmpHome(), runtime = fakeRuntime();
    const rooms = createRooms({ home, runtime, fetch: fakeFetch(), memory, sleep: async () => {} });
    await rooms.init("job");
    await rooms.up("job");
    const run = runtime.calls.find((x) => x[0] === "run");
    assert.equal(run[run.indexOf("--shm-size") + 1], expected);
  }
});

test("no `container` CLI is runtime_missing, before anything is written", async () => {
  const { rooms } = make({ runtime: fakeRuntime({ missing: true }) });
  await rooms.init("a");
  assert.equal(await code(() => rooms.up("a")), "runtime_missing");
});

// ---------- M3: lifecycle and the profile rules ----------
test("up refuses a room whose profile is gone, and never recreates it", async () => {
  const { runtime, rooms } = make();
  const r = await rooms.init("work");
  rmSync(r.profile, { recursive: true });
  assert.equal(await code(() => rooms.up("work")), "profile_missing");
  assert.ok(!existsSync(r.profile));
  assert.equal(runtime.calls.filter((c) => c[0] === "run").length, 0);
});

test("up on an unknown room is room_unknown; on a running one, profile_in_use", async () => {
  const { rooms } = make();
  assert.equal(await code(() => rooms.up("nope")), "room_unknown");
  await rooms.init("work");
  await rooms.up("work");
  assert.equal(await code(() => rooms.up("work")), "profile_in_use");
});

test("up waits for CDP through the relay with the token in the path, then reports the browser", async () => {
  let n = 0;
  const fetch = fakeFetch(() => ++n > 3);
  const { rooms } = make({ fetch });
  const r = await rooms.init("work");
  const s = await rooms.up("work");
  assert.equal(s.browser, "Chromium/150.0");
  assert.equal(fetch.seen.at(-1), `http://127.0.0.1:${r.cdp.port}/${r.cdp.token}/json/version`);
});

test("a room that never answers is health_timeout, and its container is stopped, profile kept", async () => {
  const { runtime, rooms } = make({ fetch: fakeFetch(() => false) });
  const r = await rooms.init("work");
  assert.equal(await code(() => rooms.up("work", { timeoutMs: 50 })), "health_timeout");
  assert.ok(runtime.calls.some((c) => c[0] === "stop" && c.at(-1) === "rooms-work"));
  assert.ok(existsSync(r.profile));
});

test("down stops and deletes the container but keeps the profile and the registry entry", async () => {
  const { runtime, rooms } = make();
  const r = await rooms.init("work");
  await rooms.up("work");
  await rooms.down("work");
  assert.ok(!runtime.containers.has("rooms-work"));
  assert.ok(existsSync(r.profile));
  assert.equal((await rooms.status("work")).state, "down");
  await rooms.up("work"); // and it comes back on the same profile
  assert.equal(runtime.calls.filter((c) => c[0] === "run").length, 2);
});

test("status reports up/down and the CDP endpoint; endpoint() gives a URL any CDP client can use", async () => {
  const { rooms } = make();
  const r = await rooms.init("work");
  assert.equal((await rooms.status("work")).state, "down");
  await rooms.up("work");
  const s = await rooms.status("work");
  assert.equal(s.state, "up");
  assert.equal(s.browser, "Chromium/150.0");
  assert.equal(rooms.endpoint("work"), `http://127.0.0.1:${r.cdp.port}/${r.cdp.token}`);
  assert.deepEqual((await rooms.list()).map((x) => [x.name, x.state]), [["work", "up"]]);
});

test("a registry written by a newer version, or corrupt, is refused rather than overwritten", async () => {
  const { home, rooms } = make();
  mkdirSync(home, { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(home, "rooms.json"), "{not json");
  assert.equal(await code(() => rooms.init("a")), "registry_corrupt");
  writeFileSync(join(home, "rooms.json"), JSON.stringify({ version: 99, rooms: {} }));
  assert.equal(await code(() => rooms.init("a")), "registry_version");
});

test("up holds the Mac awake (system only, display free to lock) while the room is up; down releases it", async () => {
  const held = [];
  const rooms = createRooms({ home: tmpHome(), runtime: fakeRuntime(), fetch: fakeFetch(), sleep: async () => {}, awake: { start: () => { held.push("on"); return 4242; }, stop: (pid) => held.push(`off ${pid}`) } });
  await rooms.init("work");
  await rooms.up("work");
  assert.deepEqual(held, ["on"]);
  await rooms.down("work");
  assert.deepEqual(held, ["on", "off 4242"]);
});

test("up refuses an image older than the profile before starting Chromium", async () => {
  const runtime = fakeRuntime();
  runtime.imageVersion = () => "155.0.0.0";
  const { rooms } = make({ runtime });
  const r = await rooms.init("work");
  writeFileSync(join(r.profile, "Last Version"), "156.0.8078.73\n");
  assert.equal(await code(() => rooms.up("work")), "profile_newer");
  assert.equal(runtime.calls.some((c) => c[0] === "run"), false);
  runtime.imageVersion = () => "156.0.8078.73";
  await rooms.up("work");
});

test("checkpoint clones a stopped profile, restore keeps its replaced profile, and prune removes only the checkpoint", async () => {
  const home = tmpHome(), runtime = fakeRuntime(), cloned = [];
  const rooms = createRooms({ home, runtime, fetch: fakeFetch(), sleep: async () => {}, cloneFile: (from, to) => { cloned.push(from); copyFileSync(from, to); } });
  const r = await rooms.init("work");
  writeFileSync(join(r.profile, "Last Version"), "156.0.8078.73");
  writeFileSync(join(r.profile, "sentinel"), "before");
  await rooms.up("work");
  assert.equal(await code(() => rooms.checkpoint("work", "before-update")), "room_up");
  await rooms.down("work");
  const checkpoint = await rooms.checkpoint("work", "before-update");
  assert.equal(checkpoint.id, "before-update");
  assert.equal(readFileSync(join(home, "checkpoints", "work", "before-update", "sentinel"), "utf8"), "before");
  assert.ok(cloned.some((p) => p.endsWith("sentinel")));
  writeFileSync(join(r.profile, "sentinel"), "after");
  await rooms.up("work");
  assert.equal(await code(() => rooms.restore("work", "before-update")), "room_up");
  await rooms.down("work");
  const restored = await rooms.restore("work", "before-update");
  assert.equal(readFileSync(join(r.profile, "sentinel"), "utf8"), "before");
  assert.equal(readFileSync(join(restored.previous, "sentinel"), "utf8"), "after");
  assert.deepEqual((await rooms.checkpoints("work")).map((x) => x.id), ["before-update"]);
  await rooms.prune("work", "before-update");
  assert.equal(existsSync(join(home, "checkpoints", "work", "before-update")), false);
  assert.equal(readFileSync(join(r.profile, "sentinel"), "utf8"), "before");
});

test("a clone failure leaves the current profile and no partial checkpoint", async () => {
  const home = tmpHome();
  const runtime = fakeRuntime();
  const normal = createRooms({ home, runtime, fetch: fakeFetch(), sleep: async () => {}, cloneFile: copyFileSync });
  const r = await normal.init("work");
  writeFileSync(join(r.profile, "sentinel"), "current");
  const broken = createRooms({ home, runtime, fetch: fakeFetch(), sleep: async () => {}, cloneFile: () => { throw new Error("clone unavailable"); } });
  assert.equal(await code(() => broken.checkpoint("work", "broken")), "checkpoint_failed");
  assert.equal(existsSync(join(home, "checkpoints", "work", "broken")), false);
  await normal.checkpoint("work", "good");
  assert.equal(await code(() => broken.restore("work", "good")), "restore_failed");
  assert.equal(readFileSync(join(r.profile, "sentinel"), "utf8"), "current");
});

test("heartbeat restarts the same profile after three consecutive CDP failures", async () => {
  let healthy = true;
  const { rooms, runtime, fetch } = make({ fetch: fakeFetch(() => healthy) });
  const room = await rooms.init("work");
  await rooms.up("work");
  healthy = false;
  assert.deepEqual(await rooms.heartbeat("work"), { name: "work", state: "unhealthy", failures: 1 });
  assert.deepEqual(await rooms.heartbeat("work"), { name: "work", state: "unhealthy", failures: 2 });
  healthy = true;
  assert.equal((await rooms.heartbeat("work")).state, "up");
  healthy = false;
  await rooms.heartbeat("work");
  await rooms.heartbeat("work");
  fetch.seen.length = 0;
  const orig = fetch.seen.push.bind(fetch.seen);
  fetch.seen.push = (...urls) => { const n = orig(...urls); if (n >= 3) healthy = true; return n; };
  const result = await rooms.heartbeat("work");
  assert.equal(result.state, "restarted");
  assert.equal(result.profile, room.profile);
  assert.equal(runtime.calls.filter((c) => c[0] === "run").length, 2);
  assert.ok(runtime.calls.some((c) => c[0] === "stop" && c.at(-1) === "rooms-work"));
});

test("heartbeat never starts a deliberately stopped room", async () => {
  const { rooms, runtime } = make();
  await rooms.init("work");
  assert.deepEqual(await rooms.heartbeat("work"), { name: "work", state: "down", failures: 0 });
  assert.equal(runtime.calls.some((c) => c[0] === "run"), false);
});

test("doctor returns typed states and autostart writes a private login agent", async () => {
  const home = tmpHome(), runtime = fakeRuntime();
  let healthy = true;
  const rooms = createRooms({ home, runtime, fetch: fakeFetch(() => healthy), sleep: async () => {}, launchAgents: join(home, "LaunchAgents") });
  const room = await rooms.init("work");
  assert.equal((await rooms.doctor("work")).code, "room_down");
  const agent = await rooms.autostart("work");
  assert.equal(statSync(agent.path).mode & 0o777, 0o600);
  const plist = readFileSync(agent.path, "utf8");
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<string>watch<\/string><string>work<\/string><string>--start<\/string>/);
  await rooms.up("work");
  assert.equal((await rooms.doctor("work")).code, "healthy");
  healthy = false;
  assert.equal((await rooms.doctor("work")).code, "cdp_unhealthy");
  await rooms.autostart("work", false);
  assert.equal(existsSync(agent.path), false);
  assert.equal(existsSync(room.profile), true);
});

test("per-room Chromium flags reach the mounted profile without shell splitting", async () => {
  const { rooms, runtime } = make();
  const r = await rooms.init("mobile");
  const flags = ["--user-agent=Mozilla/5.0 (Linux; Android 14) Mobile", "--touch-events=enabled"];
  assert.deepEqual(await rooms.flagsSet("mobile", flags), flags);
  assert.equal(await code(() => rooms.flagsSet("mobile", ["--remote-debugging-address=0.0.0.0"])), "bad_flag");
  await rooms.up("mobile");
  assert.equal(readFileSync(join(r.profile, ".rooms-flags"), "utf8"), flags.join("\n") + "\n");
  assert.equal(runtime.calls.filter((c) => c[0] === "run").length, 1);
  assert.equal(await code(() => rooms.flagsSet("mobile", flags)), "room_up");
});
