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
  const rooms = createRooms({ home, runtime, fetch, sleep: async () => {}, image: "rooms-chrome:test", portBase: 9300, physicalMemory: 64 * 2 ** 30 });
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
  assert.equal(at("--shm-size"), "1536M");
  assert.equal(at("--memory"), "3G");
  assert.ok(run.includes("--detach"));
  assert.ok(!run.includes("--rm"), "a room's container is never auto-removed");
  assert.equal(run.at(-1), "rooms-chrome:test");
  assert.ok(!run.join(" ").includes(r.cdp.token), "token never on the command line");
  const envFile = at("--env-file"); // read by images that predate the token file, then removed
  assert.ok(envFile.startsWith(home));
  assert.equal(existsSync(envFile), false);
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

test("status reports up/down; endpoint() gives a URL any CDP client can use", async () => {
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

test("the awake hold waits on the container's runtime helper, so it ends when the container stops on its own", async () => {
  const runtime = fakeRuntime(), waited = [];
  runtime.helperPid = (cname) => (cname === "rooms-work" ? 777 : null);
  const rooms = createRooms({ home: tmpHome(), runtime, fetch: fakeFetch(), sleep: async () => {}, physicalMemory: 64 * 2 ** 30, awake: { start: (pid) => { waited.push(pid); return 4242; }, stop: () => {} } });
  await rooms.init("work");
  await rooms.up("work");
  assert.deepEqual(waited, [777]);
});

test("up refuses a room that would put the rooms past 80% of the Mac's memory, and stops nothing", async () => {
  const home = tmpHome(), runtime = fakeRuntime();
  const rooms = createRooms({ home, runtime, fetch: fakeFetch(), sleep: async () => {}, memory: "3G", physicalMemory: 6 * 2 ** 30 });
  await rooms.init("a");
  await rooms.init("b");
  await rooms.up("a");
  assert.equal(await code(() => rooms.up("b")), "no_memory");
  assert.equal(runtime.calls.filter((c) => c[0] === "run").length, 1);
  assert.equal((await rooms.status("a")).state, "up");
});

test("status says when the room came up; down clears that record and leaves the profile alone", async () => {
  const { home, rooms } = make();
  const r = await rooms.init("work");
  await rooms.up("work");
  assert.ok(!Number.isNaN(Date.parse((await rooms.status("work")).since)));
  mkdirSync(join(r.profile, "Default", "Code Cache", "js"), { recursive: true });
  writeFileSync(join(r.profile, "Default", "Code Cache", "js", "x"), "compiled");
  writeFileSync(join(r.profile, "Default", "Cookies"), "kept");
  await rooms.down("work");
  assert.equal(readFileSync(join(r.profile, "Default", "Code Cache", "js", "x"), "utf8"), "compiled");
  assert.equal(readFileSync(join(r.profile, "Default", "Cookies"), "utf8"), "kept");
  assert.equal(existsSync(join(home, "run", "work.started")), false);
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

test("up checks the image's Chromium version once per image build", async () => {
  const runtime = fakeRuntime();
  let digest = "sha256:a", version = "156.0.8078.73", checks = 0;
  runtime.imageInfo = () => ({ digest, built: "2026-10-31T00:00:00Z" });
  runtime.imageVersion = () => { checks++; return version; };
  const { rooms } = make({ runtime });
  const r = await rooms.init("work");
  writeFileSync(join(r.profile, "Last Version"), "156.0.8078.73\n");
  await rooms.up("work"); await rooms.down("work");
  await rooms.up("work"); await rooms.down("work");
  assert.equal(checks, 1, "the same build is not asked again");
  digest = "sha256:b"; version = "155.0.0.0";
  assert.equal(await code(() => rooms.up("work")), "profile_newer", "a new build is asked, and an older Chromium still refused");
  assert.equal(checks, 2);
  assert.equal(await code(() => rooms.up("work")), "profile_newer", "a cached older version is refused too");
  assert.equal(checks, 2);
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
  assert.deepEqual((await rooms.checkpoints("work")).filter((x) => x.kind === "checkpoint").map((x) => x.id), ["before-update"]);
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

test("per-room Chromium flags reach the guest one per line, without shell splitting", async () => {
  const { home, rooms, runtime } = make();
  await rooms.init("mobile");
  const flags = ["--user-agent=Mozilla/5.0 (Linux; Android 14) Mobile", "--touch-events=enabled"];
  assert.deepEqual(await rooms.flagsSet("mobile", flags), flags);
  assert.equal(await code(() => rooms.flagsSet("mobile", ["--remote-debugging-address=0.0.0.0"])), "bad_flag");
  await rooms.up("mobile");
  assert.equal(readFileSync(join(home, "control", "mobile", "flags"), "utf8"), flags.join("\n") + "\n");
  assert.equal(runtime.calls.filter((c) => c[0] === "run").length, 1);
  assert.equal(await code(() => rooms.flagsSet("mobile", flags)), "room_up");
});

test("up, status and list never carry the token, so it stays out of transcripts; endpoint is the one way to get it", async () => {
  const { rooms } = make();
  const r = await rooms.init("work");
  const outputs = [await rooms.up("work"), await rooms.status("work"), await rooms.list(), await rooms.doctor("work")];
  for (const o of outputs) assert.ok(!JSON.stringify(o).includes(r.cdp.token), JSON.stringify(o));
  assert.equal((await rooms.status("work")).port, r.cdp.port);
});

test("profiles a restore replaced are listed with the checkpoints and can be deleted one at a time, never automatically", async () => {
  const { rooms } = make();
  const r = await rooms.init("work");
  writeFileSync(join(r.profile, "sentinel"), "before");
  await rooms.checkpoint("work", "good");
  const { previous } = await rooms.restore("work", "good");
  await rooms.restore("work", "good");
  const listed = await rooms.checkpoints("work");
  const replaced = listed.filter((c) => c.kind === "replaced");
  assert.deepEqual(listed.filter((c) => c.kind === "checkpoint").map((c) => c.id), ["good"]);
  assert.equal(replaced.length, 2);
  const id = previous.split("/").at(-1);
  assert.ok(replaced.some((c) => c.id === id));
  await rooms.prune("work", id);
  assert.equal(existsSync(previous), false);
  assert.equal((await rooms.checkpoints("work")).filter((c) => c.kind === "replaced").length, 1);
  assert.equal(readFileSync(join(r.profile, "sentinel"), "utf8"), "before");
});

test("init keeps the rooms folder out of Time Machine, where its sessions would sit on the backup disk", async () => {
  const home = tmpHome(), excluded = [];
  const rooms = createRooms({ home, runtime: fakeRuntime(), fetch: fakeFetch(), sleep: async () => {}, excludeFromBackup: (p) => excluded.push(p) });
  await rooms.init("work");
  await rooms.init("other");
  assert.deepEqual(excluded, [home, home]);
});

test("set gives one room its own memory, used from its next up; the memory check adds up what each running room was given", async () => {
  const home = tmpHome(), runtime = fakeRuntime();
  const rooms = createRooms({ home, runtime, fetch: fakeFetch(), sleep: async () => {}, memory: "2G", physicalMemory: 9 * 2 ** 30 });
  await rooms.init("figma");
  await rooms.init("jobs");
  assert.deepEqual(await rooms.set("figma", { memory: "6G" }), { name: "figma", memory: "6G" });
  assert.equal(await code(() => rooms.set("figma", { memory: "lots" })), "bad_memory");
  assert.equal(await code(() => rooms.set("figma", { color: "red" })), "bad_setting");
  await rooms.up("figma");
  const run = runtime.calls.find((c) => c[0] === "run");
  assert.equal(run[run.indexOf("--memory") + 1], "6G");
  assert.equal(run[run.indexOf("--shm-size") + 1], "2G");
  assert.equal(await code(() => rooms.up("jobs")), "no_memory"); // 6G + 2G > 80% of 9G
  assert.equal(await code(() => rooms.set("figma", { memory: "4G" })), "room_up");
});

test("a room with an idle limit is stopped by its watcher once no client has sent anything for that long; without one it stays up", async () => {
  let idleMs = 0;
  const fetch = async (url) => ({ ok: true, status: 200, json: async () => (url.endsWith("/rooms/activity") ? { idleMs } : { Browser: "Chromium/150.0" }) });
  const home = tmpHome(), runtime = fakeRuntime();
  const rooms = createRooms({ home, runtime, fetch, sleep: async () => {}, physicalMemory: 64 * 2 ** 30, connect: async () => { throw new Error("no cdp"); } });
  await rooms.init("work");
  await rooms.init("always");
  assert.equal(await code(() => rooms.set("work", { idle: "soon" })), "bad_idle");
  assert.deepEqual(await rooms.set("work", { idle: "30m" }), { name: "work", idle: "30m" });
  await rooms.up("work");
  await rooms.up("always");
  idleMs = 29 * 60000;
  assert.equal((await rooms.heartbeat("work")).state, "up");
  idleMs = 31 * 60000;
  assert.equal((await rooms.heartbeat("always")).state, "up");
  assert.equal((await rooms.heartbeat("work")).state, "stopped_idle");
  assert.equal((await rooms.status("work")).state, "down");
  assert.equal((await rooms.doctor("work")).stopRequested, true, "an idle stop is deliberate: autostart won't bring it back");
});

test("set device=phone gives the room a phone's flags and device=desktop clears them; custom flags replace the preset", async () => {
  const { rooms } = make();
  await rooms.init("m");
  assert.deepEqual(await rooms.set("m", { device: "phone" }), { name: "m", device: "phone" });
  const phone = await rooms.flags("m");
  assert.ok(phone.includes("--touch-events=enabled"));
  assert.ok(phone.some((f) => /^--user-agent=.*Mobile/.test(f)));
  assert.equal(await code(() => rooms.set("m", { device: "tablet" })), "bad_device");
  await rooms.set("m", { device: "desktop" });
  assert.deepEqual(await rooms.flags("m"), []);
  await rooms.set("m", { device: "phone" });
  await rooms.flagsSet("m", ["--window-size=800,600"]);
  assert.deepEqual(await rooms.set("m", {}), { name: "m" });
});

test("doctor lists each check with pass|warn|fail|skip, how much it matters, and the command that fixes it", async () => {
  let protocol = 1;
  const fetch = async (url) => ({ ok: true, status: 200, json: async () => (url.endsWith("/health") ? { ok: true, protocol } : { Browser: "Chromium/150.0" }) });
  const rooms = createRooms({ home: tmpHome(), runtime: fakeRuntime(), fetch, sleep: async () => {}, physicalMemory: 64 * 2 ** 30 });
  await rooms.init("work");
  const down = Object.fromEntries((await rooms.doctor("work")).checks.map((c) => [c.id, c]));
  assert.deepEqual([down.profile.status, down.container.status, down.cdp.status], ["pass", "fail", "skip"]);
  assert.equal(down.container.severity, "required");
  assert.equal(down.container.remedy, "rooms up work");
  await rooms.up("work");
  await rooms.siteAdd("work", "https://a.test/");
  await rooms.logEvent("work", "check", { sites: { "https://a.test": "signed_out" } });
  const d = await rooms.doctor("work");
  const up = Object.fromEntries(d.checks.map((c) => [c.id, c]));
  assert.equal(d.ok, true);
  assert.equal(up.cdp.status, "pass");
  assert.deepEqual([up.image.status, up.image.severity], ["warn", "recommended"]);
  assert.match(up.image.remedy, /container build/);
  assert.deepEqual([up.sites.status, up.sites.severity, up.sites.remedy], ["warn", "info", "rooms check work"]);
  protocol = 2;
  assert.equal(Object.fromEntries((await rooms.doctor("work")).checks.map((c) => [c.id, c])).image.status, "pass");
});

test("doctor warns when the room runs an older build than the image, or the image is a month old", async () => {
  const fetch = async (url) => ({ ok: true, status: 200, json: async () => (url.endsWith("/health") ? { ok: true, protocol: 2 } : { Browser: "Chromium/156.0" }) });
  const runtime = fakeRuntime();
  let running = "sha256:new", built = "2026-10-30T00:00:00Z";
  runtime.imageInfo = () => ({ digest: "sha256:new", built });
  runtime.containerImage = () => running;
  const rooms = createRooms({ home: tmpHome(), runtime, fetch, sleep: async () => {}, physicalMemory: 64 * 2 ** 30, now: () => Date.parse("2026-10-31T00:00:00Z") });
  await rooms.init("work");
  await rooms.up("work");
  const image = async () => Object.fromEntries((await rooms.doctor("work")).checks.map((c) => [c.id, c])).image;
  assert.equal((await image()).status, "pass");
  running = "sha256:old";
  let i = await image();
  assert.equal(i.status, "warn");
  assert.match(i.detail, /older build/);
  assert.equal(i.remedy, "rooms down work && rooms up work", "the image is already built: a restart is enough");
  running = "sha256:new"; built = "2026-09-20T00:00:00Z";
  i = await image();
  assert.equal(i.status, "warn");
  assert.match(i.detail, /41 days/);
  assert.match(i.remedy, /container build --no-cache /, "a cached build keeps the old Chromium");
});

test("up holds a lock while it starts the room: a second up meanwhile is refused, one left by a dead process is taken over", async () => {
  const { home, rooms } = make();
  await rooms.init("work");
  const lock = join(home, "control", "work", "up.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), String(process.pid));
  assert.equal(await code(() => rooms.up("work")), "room_busy");
  writeFileSync(join(lock, "pid"), "999999");
  await rooms.up("work");
  assert.equal(existsSync(lock), false);
});

test("status says who started the room and when; a second watcher steps aside for a live one", async () => {
  const { rooms } = make();
  await rooms.init("work");
  await rooms.up("work");
  const s = await rooms.status("work");
  assert.equal(s.owner.pid, process.pid);
  assert.equal(s.since, s.owner.startedAt);
  assert.deepEqual(await rooms.claimWatch("work", process.pid), { claimed: true, pid: process.pid });
  assert.deepEqual(await rooms.claimWatch("work", 4242), { claimed: false, pid: process.pid });
  assert.equal((await rooms.status("work")).watcher, process.pid);
  await rooms.down("work");
  assert.equal((await rooms.status("work")).owner, undefined);
});

test("up hands the token to the room in its read-only control folder and leaves no env file behind", async () => {
  const { home, runtime, rooms } = make();
  const r = await rooms.init("work");
  await rooms.up("work");
  const file = join(home, "control", "work", "token");
  assert.equal(readFileSync(file, "utf8"), r.cdp.token + "\n");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(existsSync(join(home, "run", "work.env")), false);
  assert.ok(runtime.calls.find((c) => c[0] === "run").includes("ROOMS_TOKEN_FILE=/rooms/token"));
});

test("rotate gives the room a new token without restarting it, so nothing has to sign in again", async () => {
  const { home, runtime, rooms } = make();
  const r = await rooms.init("work");
  await rooms.up("work");
  const before = runtime.calls.length;
  const out = await rooms.rotate("work");
  assert.ok(!JSON.stringify(out).includes(r.cdp.token));
  const token = JSON.parse(readFileSync(join(home, "rooms.json"), "utf8")).rooms.work.cdp.token;
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.notEqual(token, r.cdp.token);
  assert.equal(readFileSync(join(home, "control", "work", "token"), "utf8"), token + "\n");
  assert.deepEqual(runtime.calls.slice(before).map((c) => c[0]).filter((c) => c !== "list"), []);
  assert.equal((await rooms.events("work")).at(-1).event, "token-rotated");
});

test("an idle room isn't stopped while someone holds one of its tabs: an agent mid-call, or the user in the viewer", async () => {
  const { holdForUser } = await import("../leases.mjs");
  const fetch = async (url) => ({ ok: true, status: 200, json: async () => (url.endsWith("/rooms/activity") ? { idleMs: 3600000 } : url.endsWith("/json/list") ? [{ id: "T1", type: "page" }] : { Browser: "Chromium/150.0" }) });
  const home = tmpHome();
  const rooms = createRooms({ home, runtime: fakeRuntime(), fetch, sleep: async () => {}, physicalMemory: 64 * 2 ** 30, connect: async () => { throw new Error("no cdp"); } });
  await rooms.init("work");
  await rooms.set("work", { idle: "30m" });
  await rooms.up("work");
  const release = await holdForUser(home, "room:work:T1");
  assert.deepEqual([(await rooms.heartbeat("work")).state, (await rooms.heartbeat("work")).heldBy], ["up", "user"]);
  await release();
  assert.equal((await rooms.heartbeat("work")).state, "stopped_idle");
});
