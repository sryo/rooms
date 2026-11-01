#!/usr/bin/env node
// rooms: long-lived minimal Chrome rooms for perch.
// A room is one container (Apple `container`, a lightweight Linux VM) running one Chromium on one
// persistent profile, with CDP reachable on host loopback through a token relay (relay.mjs).
// The profile path is fixed per room and is created only by `init`; nothing here ever makes a
// fresh profile behind the user's back (a fresh profile is a signed-out one).

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, rmSync, readdirSync, openSync, readSync, fstatSync, closeSync, constants as fsc } from "node:fs";
import { homedir, totalmem } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectCdp, browserWsUrl } from "./cdp.mjs";
import { cloneFile as apfsClone, checkpointProfile, restoreProfile } from "./checkpoints.mjs";
import { appendEvent, readEvents } from "./events.mjs";
import { holdForUser, leaseHolder } from "./leases.mjs";

export class RoomsError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}
const fail = (code, message) => { throw new RoomsError(code, message); };

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const GUEST_RELAY_PORT = 9223;
const VERSION = 1;
export const DEFAULT_SIGNED_OUT = "(^|/)(login|log-in|signin|sign-in|sign_in|auth|session/new)([/?#]|$)";
// The guest can write anything in the profile, links included, so rooms keeps its own state out of
// it: control/<name>/ is host-owned and mounted read-only at /rooms. `stop` asks the guest not to
// restart Chromium; `flags` holds extra Chromium flags, one per line.
const LEGACY_MARKERS = [".rooms-stop", ".rooms-flags"];
const HOUR = 3600000, DAY = 24 * HOUR;
// How long nothing must have used a room before it moves to a new build of the image.
const UPDATE_QUIET_MS = HOUR;
function chromeFlags(flags) {
  if (!Array.isArray(flags) || flags.length > 8) fail("bad_flag", "pass up to eight Chromium flags");
  for (const flag of flags) {
    if (typeof flag !== "string" || /[\r\n\x00-\x1f\x7f]/.test(flag) || flag.length > 512 || !(
      /^--user-agent=.{1,500}$/.test(flag) || /^--touch-events=(enabled|disabled)$/.test(flag) ||
      /^--force-device-scale-factor=(?:[1-4](?:\.\d{1,2})?|0\.[5-9]\d?)$/.test(flag) ||
      /^--window-size=\d{3,4},\d{3,4}$/.test(flag)
    )) fail("bad_flag", `unsupported Chromium flag '${String(flag).slice(0, 80)}'`);
  }
  return flags;
}
// The one place that spells the commands rooms tells people and agents to run, so a result's
// `remedy` stays right when a command changes.
export const remedies = {
  signin: (name, url) => `rooms signin ${name} ${url}`,
  up: (name) => `rooms up ${name}`,
  check: (name) => `rooms check ${name}`,
};

// `rooms set <name> device=…`: named sets of the flags above. Change a room's device before signing
// in, since a new user agent can sign sites out.
const DEVICES = {
  desktop: [],
  phone: ["--user-agent=Mozilla/5.0 (Linux; Android 14) Mobile", "--touch-events=enabled", "--window-size=412,915", "--force-device-scale-factor=2.63"],
};

const SOURCE_PROFILES = {
  canary: ["Google", "Chrome Canary", "Chrome Canary Safe Storage"],
  chrome: ["Google", "Chrome", "Chrome Safe Storage"],
};

function macKeychain(service) {
  const r = spawnSync("security", ["find-generic-password", "-w", "-s", service], { encoding: "utf8", timeout: 120000, maxBuffer: 4096 });
  if (r.status !== 0 || !r.stdout) fail("keychain_denied", `could not read ${service}; allow the Keychain request and retry`);
  return r.stdout.replace(/\r?\n$/, "");
}

// The real runtime: Apple's `container` CLI (flags per apple/container docs/command-reference.md).
export function appleContainer(bin = "container") {
  return {
    available: () => spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0,
    exec: (argv) => { const r = spawnSync(bin, argv, { encoding: "utf8", timeout: 120000 }); return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") }; },
    imageVersion(image) {
      const r = spawnSync(bin, ["run", "--rm", "--entrypoint", "chromium", image, "--version"], { encoding: "utf8", timeout: 120000 });
      if (r.status !== 0) fail("runtime_error", `could not read ${image}'s Chromium version: ${r.stderr?.trim() || r.error || "unknown error"}`);
      const v = r.stdout.match(/Chromium\s+(\d+(?:\.\d+){3})/);
      if (!v) fail("runtime_error", `could not parse ${image}'s Chromium version`);
      return v[1];
    },
    // The image's index digest, and when its packages were installed: the apt layer's date, which a
    // cached rebuild keeps.
    imageInfo(image) {
      const r = spawnSync(bin, ["image", "inspect", image], { encoding: "utf8", timeout: 120000 });
      if (r.status !== 0) return null;
      const [d] = JSON.parse(r.stdout);
      const history = d.variants?.[0]?.config?.history ?? [];
      const built = history.filter((h) => /apt-get install/.test(h.created_by ?? "")).at(-1)?.created ?? d.configuration?.creationDate;
      return { digest: d.configuration?.descriptor?.digest, built };
    },
    containerImage(cname) {
      const r = spawnSync(bin, ["inspect", cname], { encoding: "utf8", timeout: 120000 });
      if (r.status !== 0) return null;
      const [d] = JSON.parse(r.stdout);
      return d?.configuration?.image?.descriptor?.digest ?? null;
    },
    build(tag, dir) {
      const r = spawnSync(bin, ["build", "--no-cache", "-t", tag, "-f", join(dir, "image", "Dockerfile"), dir], { encoding: "utf8", timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
      return { code: r.status ?? 1, stderr: r.stderr ?? String(r.error ?? "") };
    },
    tag: (from, to) => spawnSync(bin, ["image", "tag", from, to], { stdio: "ignore", timeout: 120000 }).status === 0,
    removeImage: (tag) => spawnSync(bin, ["image", "delete", tag], { stdio: "ignore", timeout: 120000 }),
    // The builder is a VM holding 2 GB while it runs.
    builderStop: () => spawnSync(bin, ["builder", "stop"], { stdio: "ignore", timeout: 120000 }),
    // The container's runtime helper is a launchd job (label as seen on container 1.6.1) that exits
    // when the container stops, however it stops.
    helperPid(cname) {
      const r = spawnSync("launchctl", ["list"], { encoding: "utf8" });
      const pid = Number((r.stdout || "").split("\n").find((l) => l.endsWith(`\tcom.apple.container.container-runtime-linux.${cname}`))?.split("\t")[0]);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    },
  };
}

const version = (s) => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(s ?? "").trim()); return m ? m.slice(1).map(Number) : null; };
const newer = (x, y) => { for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
// The profile's Last Version, written by the guest, so it may be a link, a pipe or anything else:
// opened without following links or blocking, and only a small regular file is read.
function profileVersion(path) {
  let fd;
  try { fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK); } catch { return null; }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(64);
    return version(buf.toString("utf8", 0, readSync(fd, buf, 0, 64, 0)));
  } catch { return null; } finally { closeSync(fd); }
}
// Whether a pid is a live process (EPERM: alive, but another user's).
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
function mebibytes(memory) {
  const m = /^(\d+)([GM])$/.exec(memory);
  if (!m) fail("bad_memory", `memory '${memory}' must be an integer count of G or M`);
  const mib = Number(m[1]) * (m[2] === "G" ? 1024 : 1);
  if (!Number.isSafeInteger(mib) || mib < 128) fail("bad_memory", "room memory must be at least 128M");
  return mib;
}
function idleMs(idle) {
  const m = /^(\d+)([mh])$/.exec(String(idle));
  if (!m || Number(m[1]) < 1) fail("bad_idle", `idle '${idle}' must be minutes or hours, like 30m or 2h`);
  return Number(m[1]) * (m[2] === "h" ? 3600000 : 60000);
}
function sharedMemory(memory) {
  const half = Math.min(2048, Math.floor(mebibytes(memory) / 2));
  return half % 1024 === 0 ? `${half / 1024}G` : `${half}M`;
}

// Opens blank, then navigates, so the first "complete" read can't be the blank page; then waits
// until the URL holds still across reads, which catches a script redirect to /login. A read that
// fails while the page is being replaced is a "not yet". Signed out: another origin, a login path,
// or a visible password field where it landed (a site that shows its login form in place).
async function checkSite(cdp, s, { loadMs, settleReads, sleep }) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", background: true });
  try {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const nav = await cdp.send("Page.navigate", { url: s.url }, sessionId);
    if (nav && nav.errorText) return { origin: s.origin, signedIn: false, error: nav.errorText };
    const t0 = Date.now();
    let loc = null, prev, still = 0;
    for (;;) {
      let v = null;
      try {
        v = (await cdp.send("Runtime.evaluate", { expression: "({href: location.href, origin: location.origin, ready: document.readyState, pw: [...document.querySelectorAll('input[type=password]')].some((e) => e.offsetParent !== null)})", returnByValue: true }, sessionId)).result.value;
      } catch {}
      if (v) loc = v;
      const settled = !!v && v.ready === "complete" && v.href !== "about:blank";
      still = settled && prev === v.href ? still + 1 : 0;
      prev = v ? v.href : undefined;
      if (still >= settleReads || Date.now() - t0 > loadMs) break;
      await sleep(500);
    }
    if (!loc) return { origin: s.origin, signedIn: false, error: "the page never answered" };
    const u = new URL(loc.href);
    const why = loc.origin !== s.origin ? "other_origin" : new RegExp(s.signedOut, "i").test(u.pathname + u.search) ? "login_path" : loc.pw ? "password_field" : null;
    // When the site's longest-lived cookie runs out: a session there can't outlast it.
    let expires = null;
    try { expires = await cdp.cookieExpiry(s.origin, sessionId); } catch {}
    return { origin: s.origin, signedIn: !why, landed: loc.href, expires, ...(why && { why }) };
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// While a room is up the Mac must not sleep (a sleeping Mac pauses the VM), but the display may
// sleep and the screen may lock: `caffeinate -i`, detached, its pid kept in run/<name>.awake.
// With the container's helper pid it also exits when the container does, even if `down` never runs.
// stop() checks the pid is still a caffeinate before killing it (pids are reused).
export const macAwake = {
  start(waitPid) {
    const p = spawn("caffeinate", ["-i", ...(waitPid ? ["-w", String(waitPid)] : [])], { detached: true, stdio: "ignore" });
    p.unref();
    return p.pid;
  },
  stop(pid) {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    if (/caffeinate/.test(r.stdout || "")) { try { process.kill(pid); } catch {} }
  },
};

// A sticky exclusion (an xattr on the folder): Time Machine would otherwise keep copies of every
// room's sessions on the backup disk. Best effort; a Mac without Time Machine set up still works.
// A banner from Script Editor's sender; AppleScript strings are escaped, never interpolated raw.
const macNotify = (title, body) => {
  const q = (x) => `"${String(x).replace(/[\\"]/g, "\\$&")}"`;
  spawnSync("osascript", ["-e", `display notification ${q(body)} with title ${q(title)}`], { stdio: "ignore", timeout: 10000 });
};
const timeMachineExclude = (path) => { spawnSync("tmutil", ["addexclusion", path], { stdio: "ignore", timeout: 10000 }); };

export function createRooms({
  home = process.env.ROOMS_HOME || join(homedir(), ".rooms"),
  runtime = appleContainer(),
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  image = process.env.ROOMS_IMAGE || "rooms-chrome:latest", // every room's image; :candidate and :previous sit beside it
  portBase = 9300,
  memory = "3G",
  shm = null,
  physicalMemory = totalmem(),
  now = Date.now,
  connect = (url) => connectCdp(url),
  awake = null, // the CLI passes macAwake; library users and tests hold nothing
  keychain = macKeychain,
  cloneFile = apfsClone,
  launchAgents = join(homedir(), "Library", "LaunchAgents"),
  excludeFromBackup = null, // the CLI passes timeMachineExclude
  notify = null, // the CLI passes macNotify
  buildContext = dirname(fileURLToPath(import.meta.url)),
} = {}) {
  const file = join(home, "rooms.json");
  const containerName = (name) => `rooms-${name}`;
  const heartbeatFailures = new Map();
  const agentFile = (name) => join(launchAgents, `ai.perch.rooms.${name}.plist`);

  const controlDir = (name) => join(home, "control", name);
  const stopFile = (name) => join(controlDir(name), "stop");
  const eventsFile = (name) => join(controlDir(name), "events.jsonl");
  const logEvent = (name, event, fields) => { mkdirSync(controlDir(name), { recursive: true, mode: 0o700 }); appendEvent(eventsFile(name), event, fields); };
  // Who started the room and when; removed by down. watcher.json: the watch process keeping it up.
  const ownerFile = (name) => join(controlDir(name), "owner.json");
  const watcherFile = (name) => join(controlDir(name), "watcher.json");
  // A crashed room the watcher couldn't bring back: {failures, retryAt, error}. down removes it.
  const restartFile = (name) => join(controlDir(name), "restart.json");
  // The image build a room was moved back from, so it isn't tried again: {skip: digest}.
  const updateFile = (name) => join(controlDir(name), "update.json");
  const updateState = join(home, "run", "update.json");
  const imageTag = (tag) => `${image.replace(/:[^:/]*$/, "")}:${tag}`;
  // An image's Chromium version, asked once per build: asking starts a container (about 0.8 s).
  function chromiumOf(tag, digest = runtime.imageInfo?.(tag)?.digest) {
    const known = join(home, "run", "image-versions.json"), versions = readJson(known) ?? {};
    if (digest && version(versions[digest])) return versions[digest];
    const v = runtime.imageVersion(tag);
    if (digest && version(v)) { mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 }); writeFileSync(known, JSON.stringify({ ...versions, [digest]: v }) + "\n", { mode: 0o600 }); }
    return v;
  }
  // A lock folder holding its maker's pid; one left by a dead process is taken over.
  function takeLock(lock) {
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = NaN;
      try { holder = Number(readFileSync(join(lock, "pid"), "utf8")); } catch {}
      if (alive(holder)) return holder;
    }
    writeFileSync(join(lock, "pid"), String(process.pid), { mode: 0o600 });
    return null;
  }
  const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };

  function load() {
    if (!existsSync(file)) return { version: VERSION, rooms: {} };
    let reg;
    try { reg = JSON.parse(readFileSync(file, "utf8")); } catch { fail("registry_corrupt", `${file} is not valid JSON; fix or move it, nothing was changed`); }
    if (reg.version !== VERSION) fail("registry_version", `${file} has version ${reg.version}, this rooms knows ${VERSION}`);
    return reg;
  }
  function save(reg) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  }
  function get(name) {
    const r = load().rooms[name];
    if (!r) fail("room_unknown", `no room '${name}'; rooms init ${name}`);
    return r;
  }
  function freePort(reg) {
    const used = new Set(Object.values(reg.rooms).map((r) => r.cdp.port));
    for (let p = portBase; p < portBase + 100; p++) if (!used.has(p)) return p;
    fail("no_port", `ports ${portBase}-${portBase + 99} are all assigned`);
  }
  function containers() {
    const r = runtime.exec(["list", "--all", "--format", "json"]);
    if (r.code !== 0) fail("runtime_error", `container list: ${r.stderr.trim()}`);
    const rows = JSON.parse(r.stdout || "[]");
    // `container list --format json` rows: {configuration: {id}, status: {state: "running"|"stopped"}} (seen on 1.6.1).
    return new Map(rows.map((c) => [c.configuration?.id ?? c.id, String(c.status?.state ?? c.status ?? "").toLowerCase()]));
  }
  const endpoint = (name) => { const r = get(name); return `http://${r.cdp.host}:${r.cdp.port}/${r.cdp.token}`; };
  async function probe(name) {
    const res = await fetch(`${endpoint(name)}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

async function startRoom(name, { timeoutMs = 60000, image: override } = {}) {
    const img = override ?? image;
    const room = get(name);
    if (!existsSync(room.profile)) fail("profile_missing", `${room.profile} is gone; restore it, or rooms init a new room (it starts signed out)`);
    if (!runtime.available()) fail("runtime_missing", "Apple's `container` CLI isn't installed or isn't running (brew install container; container system start)");
    const cname = containerName(name);
    const state = containers().get(cname);
    if (state === "running") fail("profile_in_use", `${cname} is already running on ${room.profile}`);
    // A room holds the memory it has touched until it stops (the VM gives none back), so a new one
    // is refused rather than let the rooms together crowd out the Mac.
    const all = load().rooms, size = (r) => r?.memory ?? memory;
    const running = [...containers()].filter(([id, s]) => id.startsWith("rooms-") && s === "running").map(([id]) => all[id.slice(6)]);
    const used = running.reduce((n, r) => n + mebibytes(size(r)), 0);
    if ((used + mebibytes(size(room))) * 1048576 > 0.8 * physicalMemory) fail("no_memory", `${running.length} rooms are up using ${Math.round(used / 1024)} GB; ${name} needs ${size(room)} more, past 80% of this Mac's ${Math.round(physicalMemory / 2 ** 30)} GB. rooms list shows them; rooms down one that isn't in use`);
    // An older Chromium wipes a newer profile's cookie jar (Linux has no downgrade guard), so a room
    // never starts on an older major version. A patch-level drop changes no database and is logged.
    const profileAt = runtime.imageVersion ? profileVersion(join(room.profile, "Last Version")) : null;
    const info = profileAt && runtime.imageInfo ? runtime.imageInfo(img) : undefined;
    if (profileAt && info !== null) {
      let imageAt;
      try { imageAt = version(chromiumOf(img, info?.digest)); } catch (e) { logEvent(name, "version-unknown", { image: img, error: e.message }); }
      if (imageAt && newer(profileAt, imageAt)) {
        const [p, b] = [profileAt.join("."), imageAt.join(".")];
        if (profileAt[0] > imageAt[0]) fail("profile_newer", `profile ${name} was used by Chromium ${p} and image ${img} has ${b}, which would sign every site out. Build a newer one with rooms update, or go back to a checkpoint from before: rooms snapshot list ${name}, then rooms snapshot restore ${name} <id>`);
        logEvent(name, "image-older", { profile: p, image: b });
      }
    }
    if (state) runtime.exec(["delete", cname]); // a stopped leftover; the profile is on the host, so nothing is lost
    for (const m of LEGACY_MARKERS) rmSync(join(room.profile, m), { force: true }); // a link is removed, not followed
    const control = controlDir(name);
    mkdirSync(control, { recursive: true, mode: 0o700 });
    rmSync(stopFile(name), { force: true });
    const flags = chromeFlags(room.flags ?? []);
    if (flags.length) writeFileSync(join(control, "flags"), flags.join("\n") + "\n", { mode: 0o600 });
    else rmSync(join(control, "flags"), { force: true });

    const envFile = join(home, "run", `${name}.env`);
    mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
    const downloads = join(home, "downloads", name);
    mkdirSync(downloads, { recursive: true, mode: 0o700 });
    writeFileSync(envFile, `ROOMS_TOKEN=${room.cdp.token}\n`, { mode: 0o600 });
    chmodSync(envFile, 0o600);
    writeFileSync(join(control, "token"), room.cdp.token + "\n", { mode: 0o600 });

    const r = runtime.exec([
      "run", "--detach",
      "--name", cname,
      "--publish", `127.0.0.1:${room.cdp.port}:${GUEST_RELAY_PORT}`,
      "--volume", `${room.profile}:/profile`,
      "--volume", `${downloads}:/downloads`,
      "--mount", `type=bind,source=${control},target=/rooms,readonly`,
      // The token file is what the room's relay reads (and rereads, so rotate works); the env file
      // is for images built before it, and only exists while `container run` reads it.
      "--env-file", envFile,
      "--env", "ROOMS_TOKEN_FILE=/rooms/token",
      "--memory", size(room),
      "--shm-size", shm ?? sharedMemory(size(room)),
      "--label", `rooms.name=${name}`,
      img,
    ]);
    rmSync(envFile, { force: true });
    if (r.code !== 0) fail("runtime_error", `container run: ${r.stderr.trim()}`);

    const awakeFile = join(home, "run", `${name}.awake`);
    const holdAwake = (waitPid) => {
      if (!awake) return;
      if (existsSync(awakeFile)) awake.stop(Number(readFileSync(awakeFile, "utf8")));
      const pid = awake.start(waitPid);
      if (pid) writeFileSync(awakeFile, String(pid), { mode: 0o600 });
    };
    const t0 = Date.now();
    let last;
    for (;;) {
      let v;
      try { v = await probe(name); } catch (e) { last = e; }
      if (v) {
        heartbeatFailures.delete(name);
        holdAwake(runtime.helperPid?.(cname));
        writeFileSync(ownerFile(name), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
        logEvent(name, "up", { browser: v.Browser });
        return { name, state: "up", browser: v.Browser, port: room.cdp.port };
      }
      if (Date.now() - t0 > timeoutMs) {
        runtime.exec(["stop", cname]);
        fail("health_timeout", `no CDP from ${cname} after ${timeoutMs} ms (${last?.message}); stopped it, profile kept`);
      }
      await sleep(500);
    }
  }

  return {
    endpoint,
    async logEvent(name, event, fields) { get(name); logEvent(name, event, fields); },
    async events(name) { get(name); return readEvents(eventsFile(name)); },

    // Options other than the name are ignored on purpose: the profile path is not configurable.
    async init(name) {
      if (typeof name !== "string" || !NAME.test(name)) fail("bad_name", `'${name}': lowercase letters, digits and dashes, starting with a letter`);
      const reg = load();
      if (reg.rooms[name]) fail("room_exists", `room '${name}' already exists`);
      const room = {
        name,
        runtime: "apple-container",
        profile: join(home, "profiles", name),
        cdp: { host: "127.0.0.1", port: freePort(reg), token: randomBytes(24).toString("hex") },
        createdAt: new Date().toISOString(),
      };
      mkdirSync(room.profile, { recursive: true, mode: 0o700 });
      reg.rooms[name] = room;
      save(reg);
      excludeFromBackup?.(home);
      return room;
    },

    // One up at a time per room: the lock is a folder (made atomically) holding the pid that made
    // it, so a lock left by a process that died is taken over.
    async up(name, opts) {
      get(name);
      const lock = join(controlDir(name), "up.lock"), holder = takeLock(lock);
      if (holder) fail("room_busy", `another rooms up (pid ${holder}) is starting ${name}; wait for it`);
      try { return await startRoom(name, opts); }
      finally { rmSync(lock, { recursive: true, force: true }); }
    },

    async down(name) {
      const room = get(name);
      heartbeatFailures.delete(name);
      const cname = containerName(name);
      const state = containers().get(cname);
      if (state === "running") {
        // Tell the guest supervisor that Browser.close is deliberate before sending it.
        mkdirSync(controlDir(name), { recursive: true, mode: 0o700 });
        writeFileSync(stopFile(name), "", { mode: 0o600 });
        // Chromium writes cookies to disk lazily (~30 s); a clean Browser.close flushes them, so a
        // sign-in made just before `down` survives. Best effort: the stop below still runs.
        try {
          const cdp = await connect(await browserWsUrl(endpoint(name), fetch));
          await cdp.send("Browser.close").catch(() => {});
          cdp.close();
          const t0 = Date.now();
          while (Date.now() - t0 < 5000) { try { await probe(name); } catch { break; } await sleep(250); }
        } catch {}
        runtime.exec(["stop", "--time", "15", cname]);
      }
      if (state) runtime.exec(["delete", cname]);
      rmSync(ownerFile(name), { force: true });
      const awakeFile = join(home, "run", `${name}.awake`);
      if (awake && existsSync(awakeFile)) { awake.stop(Number(readFileSync(awakeFile, "utf8"))); rmSync(awakeFile, { force: true }); }
      rmSync(restartFile(name), { force: true });
      if (state) logEvent(name, "down", {});
      return { name, state: "down" };
    },

    async heartbeat(name, { after = 3 } = {}) {
      const room = get(name);
      if (!Number.isInteger(after) || after < 1) fail("bad_args", "heartbeat after must be a positive integer");
      if (!runtime.available()) fail("runtime_missing", "Apple's `container` CLI isn't available");
      if (containers().get(containerName(name)) !== "running") {
        heartbeatFailures.delete(name);
        const pending = readJson(restartFile(name));
        if (!pending) return { name, state: "down", failures: 0 };
        if (now() < Date.parse(pending.retryAt)) return { name, state: "restart_failed", retryAt: pending.retryAt, error: pending.error };
        return this.restart(name, pending);
      }
      let v;
      try { v = await probe(name); } catch {}
      if (v) {
        heartbeatFailures.delete(name);
        // How long since a client last used the room; asked only when something would act on it.
        let idle;
        const quiet = async (ms) => {
          if (idle === undefined) { idle = null; try { const res = await fetch(`${endpoint(name)}/rooms/activity`, { signal: AbortSignal.timeout(3000) }); if (res.ok) idle = (await res.json()).idleMs; } catch {} }
          return idle > ms;
        };
        // Nor while one of its tabs is held: an agent mid-call, or the user at the viewer.
        const holder = async () => {
          try {
            const res = await fetch(`${endpoint(name)}/json/list`, { signal: AbortSignal.timeout(3000) });
            const pages = res.ok ? await res.json() : [];
            return pages.map((p) => leaseHolder(home, `room:${name}:${p.id}`)).find(Boolean)?.owner;
          } catch { return undefined; }
        };
        // A newer build of the image is taken up once nothing has used the room for an hour.
        const target = runtime.imageInfo?.(image)?.digest, runs = target && runtime.containerImage?.(containerName(name));
        if (runs && runs !== target && readJson(updateFile(name))?.skip !== target && await quiet(UPDATE_QUIET_MS)) {
          const heldBy = await holder();
          if (heldBy) return { name, state: "up", browser: v.Browser, failures: 0, heldBy };
          return this.moveToImage(name, target);
        }
        // Stopping closes the room's tabs, so only a room given an idle limit is ever stopped for it.
        if (room.idle && await quiet(idleMs(room.idle))) {
          const heldBy = await holder();
          if (heldBy) return { name, state: "up", browser: v.Browser, failures: 0, heldBy };
          await this.down(name); logEvent(name, "idle-down", { idleMs: idle }); return { name, state: "stopped_idle", idleMs: idle };
        }
        return { name, state: "up", browser: v.Browser, failures: 0 };
      }
      const failures = (heartbeatFailures.get(name) || 0) + 1;
      heartbeatFailures.set(name, failures);
      if (failures < after) return { name, state: "unhealthy", failures };
      logEvent(name, "crashed", { failures });
      await this.down(name);
      return this.restart(name, null);
    },

    // Moves a room onto the image's current build behind a checkpoint. If it doesn't come up, or a
    // site signed in at its last check is signed out after, the checkpoint and the previous build
    // come back, and that build isn't tried again.
    async moveToImage(name, target) {
      const room = get(name);
      const before = readEvents(eventsFile(name)).filter((e) => e.event === "check").at(-1)?.sites ?? {};
      await this.down(name);
      const id = `pre-update-${new Date(now()).toISOString().replace(/\D/g, "").slice(0, 14)}`;
      await this.checkpoint(name, id);
      let problem;
      try { await this.up(name); } catch (e) { problem = `didn't start (${e.message})`; }
      if (!problem && (room.sites ?? []).length) {
        const after = await this.check(name).catch(() => []);
        const lost = after.filter((s) => s.state === "signed_out" && before[s.origin] === "signed_in").map((s) => s.origin);
        if (lost.length) problem = `signed out of ${lost.join(", ")}`;
      }
      if (!problem) {
        logEvent(name, "updated", { image: target });
        const old = (await this.checkpoints(name)).filter((c) => c.kind === "checkpoint" && c.id.startsWith("pre-update-")).slice(0, -2);
        for (const c of old) await this.prune(name, c.id);
        return { name, state: "updated", checkpoint: id };
      }
      await this.down(name);
      await this.restore(name, id);
      mkdirSync(controlDir(name), { recursive: true, mode: 0o700 });
      writeFileSync(updateFile(name), JSON.stringify({ skip: target }) + "\n", { mode: 0o600 });
      logEvent(name, "update-rolled-back", { image: target, problem });
      notify?.("rooms", `${name} stayed on its previous build: the new one ${problem}`);
      const previous = imageTag("previous");
      await this.up(name, runtime.imageInfo?.(previous) ? { image: previous } : undefined);
      return { name, state: "rolled_back", problem, checkpoint: id };
    },

    // Builds the image again at most once a day, and makes the build the image only if its Chromium
    // is newer; the build it replaces is kept as :previous. Rooms then move over on their own.
    async update({ force = false } = {}) {
      const st = readJson(updateState) ?? {};
      if (!force && st.checkedAt && now() - Date.parse(st.checkedAt) < DAY) return { state: "not_due", checkedAt: st.checkedAt };
      const lock = join(home, "run", "update.lock"), holder = takeLock(lock);
      if (holder) return { state: "busy", pid: holder };
      const record = (x) => writeFileSync(updateState, JSON.stringify({ ...st, checkedAt: new Date(now()).toISOString(), ...x }) + "\n", { mode: 0o600 });
      try {
        const candidate = imageTag("candidate");
        let r;
        try { r = runtime.build(candidate, buildContext); } finally { runtime.builderStop?.(); }
        if (r.code !== 0) {
          const error = r.stderr.trim().split("\n").at(-1) || "build failed";
          if (!st.failing) notify?.("rooms", `couldn't build a new room image: ${error}. Rooms keep the one they have; rooms update tries again`);
          record({ failing: error });
          return { state: "build_failed", error };
        }
        const to = chromiumOf(candidate), from = runtime.imageInfo?.(image) ? chromiumOf(image) : null;
        if (version(to) && (!version(from) || newer(version(to), version(from)))) {
          if (from) runtime.tag(image, imageTag("previous"));
          runtime.tag(candidate, image);
          runtime.removeImage(candidate);
          record({ failing: null, promotedAt: new Date(now()).toISOString(), version: to });
          return { state: "promoted", from, to };
        }
        runtime.removeImage(candidate);
        record({ failing: null });
        return { state: "current", version: from };
      } finally { rmSync(lock, { recursive: true, force: true }); }
    },

    // Brings a crashed room back. On failure the next try waits twice as long (1 min up to 30), and
    // the user is told once, then again when it is back.
    async restart(name, pending) {
      const room = get(name);
      try {
        await this.up(name);
        rmSync(restartFile(name), { force: true });
        if (pending) notify?.("rooms", `${name} is back up`);
        return { name, state: "restarted", profile: room.profile, failures: 0 };
      } catch (e) {
        const failures = (pending?.failures ?? 0) + 1;
        const retryAt = new Date(now() + Math.min(30, 2 ** (failures - 1)) * 60000).toISOString();
        mkdirSync(controlDir(name), { recursive: true, mode: 0o700 });
        writeFileSync(restartFile(name), JSON.stringify({ failures, retryAt, error: e.message }) + "\n", { mode: 0o600 });
        logEvent(name, "restart-failed", { failures, error: e.message });
        if (failures === 1) notify?.("rooms", `${name} could not restart: ${e.message}. Retrying; rooms status ${name} --deep says more`);
        return { name, state: "restart_failed", retryAt, error: e.message };
      }
    },

    // Each check: {id, status: pass|warn|fail|skip, severity: required|recommended|info, remedy?}.
    // ok and code are the first required check that fails, or healthy.
    async doctor(name) {
      const room = get(name);
      const checks = [];
      const add = (id, severity, status, extra = {}) => checks.push({ id, status, severity, ...extra });
      const profileOk = existsSync(room.profile);
      add("profile", "required", profileOk ? "pass" : "fail", profileOk ? {} : { detail: `${room.profile} is gone`, remedy: `rooms snapshot list ${name}` });
      const runtimeOk = runtime.available();
      add("runtime", "required", runtimeOk ? "pass" : "fail", runtimeOk ? {} : { remedy: "brew install container && container system start" });
      const running = runtimeOk && containers().get(containerName(name)) === "running";
      const pending = !running && readJson(restartFile(name));
      add("container", "required", running ? "pass" : "fail", running ? {} : { stopRequested: existsSync(stopFile(name)), ...(pending && { detail: `restart failing since ${pending.failures} tries (${pending.error}); next try ${pending.retryAt}` }), remedy: remedies.up(name) });
      let browser, cdpError;
      if (running) { try { browser = (await probe(name)).Browser; } catch (e) { cdpError = e.message; } }
      add("cdp", "required", !running ? "skip" : browser ? "pass" : "fail", cdpError ? { detail: cdpError, remedy: `rooms down ${name} && ${remedies.up(name)}` } : {});
      let protocol = 0;
      if (browser) { try { const res = await fetch(`http://${room.cdp.host}:${room.cdp.port}/health`, { signal: AbortSignal.timeout(3000) }); if (res.ok) protocol = (await res.json()).protocol ?? 0; } catch {} }
      // Chromium's security fixes reach a room only through a rebuilt image and a restart.
      const restart = `rooms down ${name} && ${remedies.up(name)}`, rebuild = `container build --no-cache -t ${image} -f image/Dockerfile . (in the rooms folder), then ${restart}`;
      const info = browser ? runtime.imageInfo?.(image) : null, runs = info && runtime.containerImage?.(containerName(name));
      // Current as of the later of the image's packages and the last build that found nothing newer.
      const upd = readJson(updateState), fresh = Math.max(info?.built ? Date.parse(info.built) : 0, upd?.checkedAt && !upd.failing ? Date.parse(upd.checkedAt) : 0);
      const days = fresh ? Math.floor((now() - fresh) / DAY) : 0;
      const stale = !browser ? null
        : protocol < 2 ? { detail: "the room runs an older image, so its device, flags and idle settings may not apply", remedy: rebuild }
        : runs && runs !== info.digest ? { detail: `the room runs an older build than ${image}`, remedy: restart }
        : upd?.failing ? { detail: `the last image build failed (${upd.failing})`, remedy: "rooms update" }
        : days >= 30 ? { detail: `${image}'s packages are ${days} days old, so Chromium may lack security fixes`, remedy: "rooms update" }
        : null;
      add("image", "recommended", !browser ? "skip" : stale ? "warn" : "pass", stale ?? {});
      const lastCheck = readEvents(eventsFile(name)).filter((e) => e.event === "check").at(-1);
      const notIn = lastCheck ? Object.entries(lastCheck.sites ?? {}).filter(([, st]) => st !== "signed_in").map(([o]) => o) : [];
      add("sites", "info", !(room.sites ?? []).length ? "skip" : !lastCheck || notIn.length ? "warn" : "pass", (room.sites ?? []).length && (!lastCheck || notIn.length) ? { detail: lastCheck ? `not signed in at the last check: ${notIn.join(", ")}` : "never checked", remedy: remedies.check(name) } : {});
      const failed = checks.find((c) => c.severity === "required" && c.status === "fail");
      const code = !failed ? "healthy" : { profile: "profile_missing", runtime: "runtime_missing", container: "room_down", cdp: "cdp_unhealthy" }[failed.id];
      return { name, ok: !failed, code, ...(browser && { browser }), ...(cdpError && { error: cdpError }), ...(failed?.id === "container" && { stopRequested: failed.stopRequested }), profile: room.profile, checks };
    },

    // The user's lease on a room tab while they watch or drive it; returns its release.
    async holdTab(name, targetId) { get(name); return holdForUser(home, `room:${name}:${targetId}`); },

    // A new token for the room. A running room's relay rereads it from control/<name>/token and
    // closes connections made with the old one; clients reconnect with the new one from rooms.json.
    // The browser isn't restarted, so no site signs out.
    async rotate(name) {
      get(name);
      const reg = load();
      reg.rooms[name].cdp.token = randomBytes(24).toString("hex");
      save(reg);
      mkdirSync(controlDir(name), { recursive: true, mode: 0o700 });
      const tmp = join(controlDir(name), `token.${process.pid}.tmp`);
      writeFileSync(tmp, reg.rooms[name].cdp.token + "\n", { mode: 0o600 });
      renameSync(tmp, join(controlDir(name), "token"));
      logEvent(name, "token-rotated", {});
      return { name, rotated: true };
    },

    // The watch process keeping the room up. A second one steps aside while the first lives.
    async claimWatch(name, pid = process.pid) {
      get(name);
      const held = readJson(watcherFile(name))?.pid;
      if (held !== pid && alive(held)) return { claimed: false, pid: held };
      mkdirSync(controlDir(name), { recursive: true, mode: 0o700 });
      writeFileSync(watcherFile(name), JSON.stringify({ pid, since: new Date().toISOString() }) + "\n", { mode: 0o600 });
      return { claimed: true, pid };
    },

    async autostart(name, enabled = true) {
      get(name);
      const path = agentFile(name);
      if (!enabled) { rmSync(path, { force: true }); return { name, enabled: false, path }; }
      const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
      const args = [process.execPath, fileURLToPath(import.meta.url), "watch", name, "--start"];
      const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>ai.perch.rooms.${esc(name)}</string>\n<key>ProgramArguments</key><array>${args.map((x) => `<string>${esc(x)}</string>`).join("")}</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n</dict></plist>\n`;
      mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
      writeFileSync(path, plist, { mode: 0o600 });
      return { name, enabled: true, path };
    },

    async status(name) {
      const room = get(name);
      const state = runtime.available() ? containers().get(containerName(name)) : undefined;
      if (state !== "running") return { name, state: "down", profile: room.profile };
      try { const v = await probe(name); const owner = readJson(ownerFile(name)), watcher = readJson(watcherFile(name))?.pid; return { name, state: "up", since: owner?.startedAt, owner, ...(alive(watcher) && { watcher }), browser: v.Browser, port: room.cdp.port, profile: room.profile }; }
      catch (e) { return { name, state: "unhealthy", error: e.message, profile: room.profile }; }
    },

    // Sites the user signs in to once; `check` tells which still are, without reading cookies:
    // it opens the site in a fresh tab and looks where it lands.
    async siteAdd(name, url, { signedOut = DEFAULT_SIGNED_OUT } = {}) {
      let origin;
      try { origin = new URL(url).origin; } catch { fail("bad_url", `'${url}' is not a URL`); }
      if (!origin.startsWith("https://")) fail("bad_url", `'${url}': sites must be https`);
      try { new RegExp(signedOut); } catch { fail("bad_pattern", `'${signedOut}' is not a regular expression`); }
      const reg = load();
      const room = reg.rooms[name] ?? fail("room_unknown", `no room '${name}'`);
      room.sites ??= [];
      const existing = room.sites.find((s) => s.origin === origin);
      if (existing) Object.assign(existing, { url, signedOut });
      else room.sites.push({ origin, url, signedOut });
      save(reg);
      return room.sites;
    },
    async sites(name) { return get(name).sites ?? []; },

    async flagsSet(name, flags) {
      chromeFlags(flags);
      if (containers().get(containerName(name)) === "running") fail("room_up", `room '${name}' is up; rooms down ${name} before changing flags`);
      const reg = load();
      const room = reg.rooms[name] ?? fail("room_unknown", `no room '${name}'`);
      room.flags = flags;
      delete room.device; // custom flags replace a device preset
      save(reg);
      return flags;
    },
    async flags(name) { return get(name).flags ?? []; },

    // Per-room settings, used from the room's next up.
    async set(name, settings) {
      const known = {
        memory: (v) => { mebibytes(v); },
        idle: (v) => { idleMs(v); },
        device: (v) => { if (!Object.hasOwn(DEVICES, v)) fail("bad_device", `device '${v}' is one of ${Object.keys(DEVICES).join(", ")}`); },
      };
      for (const [k, v] of Object.entries(settings)) {
        if (!known[k]) fail("bad_setting", `unknown setting '${k}'; rooms set takes ${Object.keys(known).join(", ")}`);
        known[k](v);
      }
      get(name);
      if (containers().get(containerName(name)) === "running") fail("room_up", `room '${name}' is up; rooms down ${name} before changing its settings`);
      const reg = load();
      Object.assign(reg.rooms[name], settings);
      if (settings.device) reg.rooms[name].flags = DEVICES[settings.device];
      save(reg);
      return { name, ...Object.fromEntries(Object.keys(known).filter((k) => reg.rooms[name][k] !== undefined).map((k) => [k, reg.rooms[name][k]])) };
    },

    async checkpoint(name, id = `cp-${Date.now().toString(36)}`) {
      const room = get(name);
      if (containers().get(containerName(name)) === "running") fail("room_up", `room '${name}' is up; rooms down ${name} first`);
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) fail("bad_checkpoint", "checkpoint names use lowercase letters, digits and dashes");
      if (!existsSync(room.profile)) fail("profile_missing", `room '${name}' profile is missing`);
      try { checkpointProfile(room.profile, join(home, "checkpoints", name, id), cloneFile); }
      catch (e) { const m = /^(checkpoint_exists|profile_missing): (.*)$/.exec(String(e.message)); fail(m?.[1] ?? "checkpoint_failed", m?.[2] ?? e.message); }
      return { name, id };
    },
    // Profiles a restore replaced are listed too, so they can be found and deleted; nothing deletes
    // them on its own.
    async checkpoints(name) {
      get(name);
      const dirs = (path, kind) => existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => ({ id: x.name, kind })).sort((a, b) => a.id.localeCompare(b.id)) : [];
      return [...dirs(join(home, "checkpoints", name), "checkpoint"), ...dirs(join(home, "replaced", name), "replaced")];
    },
    async restore(name, id) {
      const room = get(name);
      if (containers().get(containerName(name)) === "running") fail("room_up", `room '${name}' is up; rooms down ${name} first`);
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) fail("bad_checkpoint", "name a checkpoint to restore");
      let previous;
      try { previous = restoreProfile(room.profile, join(home, "checkpoints", name, id), join(home, "replaced", name), cloneFile); }
      catch (e) { const m = /^(checkpoint_missing|profile_missing): (.*)$/.exec(String(e.message)); fail(m?.[1] ?? "restore_failed", m?.[2] ?? e.message); }
      return { name, id, previous };
    },
    async prune(name, id) {
      get(name);
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) fail("bad_checkpoint", "name a checkpoint to prune");
      const path = [join(home, "checkpoints", name, id), join(home, "replaced", name, id)].find((p) => existsSync(p));
      if (!path) fail("checkpoint_missing", `checkpoint '${id}' does not exist`);
      rmSync(path, { recursive: true });
      return { name, id, pruned: true };
    },

    async teleport(name, { from, sites } = {}) {
      const { siteNames, cookieFile, copyCookies } = await import("./teleport.mjs");
      let selected;
      try { selected = siteNames(sites); }
      catch (e) { const [code, message] = String(e.message).split(": "); fail(code, message); }
      const room = get(name);
      if (containers().get(containerName(name)) === "running") fail("room_up", `room '${name}' is up; rooms down ${name} before teleport`);
      const roomProfile = join(room.profile, "Default");
      // The guest could have swapped any of these for a link; the host would then write elsewhere.
      for (const p of [roomProfile, join(roomProfile, "Network"), join(roomProfile, "Network", "Cookies"), join(roomProfile, "Cookies")]) {
        try { if (lstatSync(p).isSymbolicLink()) fail("profile_link", `${p} is a link; rooms won't write through it. Remove it and start and stop the room once`); }
        catch (e) { if (e instanceof RoomsError) throw e; }
      }
      if (!cookieFile(roomProfile)) fail("room_never_started", `room '${name}' has no Cookies database; start and stop it once`);
      const alias = SOURCE_PROFILES[from];
      const sourceProfile = alias ? join(homedir(), "Library", "Application Support", alias[0], alias[1], "Default") : from;
      if (typeof sourceProfile !== "string" || !isAbsolute(sourceProfile)) fail("bad_source", "--from must be canary, chrome, or an absolute profile path");
      if (!cookieFile(sourceProfile)) fail("source_profile_missing", `no Cookies database in ${sourceProfile}`);
      const secret = keychain(alias?.[2] ?? "Chrome Safe Storage");
      if (typeof secret !== "string" || !secret) fail("keychain_denied", "the Chrome Safe Storage secret was not available");
      try {
        const r = await copyCookies({ sourceProfile, roomProfile, sites: selected, password: secret });
        logEvent(name, "signin.import", { from: alias ? from : "profile", sites: selected, copied: r.copied });
        return r;
      }
      catch (e) {
        const [code, ...rest] = String(e.message).split(": ");
        if (/^[a-z_]+$/.test(code) && rest.length) fail(code, rest.join(": "));
        fail("teleport_failed", `cookie transfer failed (${e.message}); the room profile was not partially updated`);
      }
    },

    async check(name, { loadMs = 20000, settleReads = 3 } = {}) {
      const room = get(name);
      const st = await this.status(name);
      if (st.state !== "up") fail("room_down", `room '${name}' is ${st.state}; ${remedies.up(name)}`);
      const cdp = await connect(await browserWsUrl(endpoint(name), fetch));
      try {
        const out = [];
        for (const s of room.sites ?? []) {
          // Each site on its own: one that fails to load or keeps dropping its page is signed out
          // with an error, and the others are still checked.
          let r;
          try { r = await checkSite(cdp, s, { loadMs, settleReads, sleep }); }
          catch (e) { r = { origin: s.origin, signedIn: false, error: e.message }; }
          // A site that couldn't be checked is unknown, not signed out: signing in again won't help.
          const state = r.signedIn ? "signed_in" : r.error ? "unknown" : "signed_out";
          out.push({ ...r, state, ...(state === "signed_out" && { remedy: remedies.signin(name, s.url) }), ...(state === "unknown" && { remedy: remedies.check(name) }) });
        }
        logEvent(name, "check", { sites: Object.fromEntries(out.map((s) => [s.origin, s.state])) });
        return out;
      } finally { cdp.close(); }
    },

    async list() {
      return Promise.all(Object.keys(load().rooms).sort().map((n) => this.status(n)));
    },
  };
}

// ---------- CLI ----------
const USAGE = `usage: rooms init <name> | up <name> | down <name>
       rooms status [<name>] [--deep]        every room, or one (exit 1 unless up); --deep checks why
       rooms signin <name> <url>             watch and drive the room, with a sign-in sheet for the site
       rooms signin <name> --from chrome|canary|<profile-path> <site>...   copy those sites' sessions
       rooms view <name> [--no-open]         watch and drive the room
       rooms site add <name> <https-url> [--signed-out <regex>] | site list <name>
       rooms check <name>                    which sites are still signed in (exit 1 if any isn't)
       rooms set <name> memory=4G idle=30m device=phone|desktop   used from the next up; idle stops
                                             a watched room nothing has used for that long, closing its tabs
       rooms snapshot save|list|restore|delete <name> [<id>]   a stopped room's profile
       rooms autostart <name> on|off         start it at login; restart it if its browser stops answering, and
                                             move it to each new Chromium once nothing has used it for an hour
       rooms update                          build the image now; autostarted rooms do it once a day
       rooms endpoint <name> [--ws]          CDP endpoint with its token (http, or the browser ws URL)
       rooms rotate <name>                   a new token; the room keeps running and stays signed in
       rooms logs <name> [--follow] [--until <event>]   what happened to the room
       rooms flags set <name> <flag>... | flags list <name>   custom Chromium flags instead of a device
Output is JSON when piped or with --json. Older names still work: list, doctor, teleport,
checkpoint(s), restore, prune, watch, view --signin.`;
const opt = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
export async function main(argv, rooms = createRooms({ awake: macAwake, excludeFromBackup: timeMachineExclude, notify: macNotify }), out = console.log, {
  tty = process.stdout.isTTY,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  viewer = async (name, opts) => (await import("./view.mjs")).startViewer({ wsUrl: await browserWsUrl(rooms.endpoint(name)), connect: (u) => connectCdp(u), ...opts }),
  untilClosed = () => new Promise((r) => { process.once("SIGINT", r); process.once("SIGTERM", r); }),
} = {}) {
  const json = argv.includes("--json") || !tty;
  argv = argv.filter((a) => a !== "--json");
  const [cmd, name] = argv;
  // A record per line for people: its name and state first, then key=value.
  const line = (x) => {
    if (x === null || typeof x !== "object") return String(x);
    const { name: n, state, code, ...rest } = x;
    return [n, state ?? code, ...Object.entries(rest).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)].filter((v) => v !== undefined).join("  ");
  };
  const report = (d) => {
    if (json) return out(JSON.stringify(d));
    out(`${d.name}  ${d.code}`);
    for (const c of d.checks ?? []) out(`  ${c.status === "pass" ? "pass" : c.status.toUpperCase()}  ${c.id}${c.detail ? `  (${c.detail})` : ""}${c.remedy ? `  -> ${c.remedy}` : ""}`);
  };
  const print = (x) => { if (json) out(JSON.stringify(x)); else for (const r of Array.isArray(x) ? x : [x]) out(line(r)); };
  // Watch and drive the room in the default browser until Ctrl-C; with a URL, a sign-in sheet for it.
  // The user holds the shown tab meanwhile (agents get tab_held), and the event log brackets it
  // with handoff.started and handoff.ended, which comes once the site is signed in, or on close.
  async function view(name, signin, noOpen) {
    const st = await rooms.status(name);
    if (st.state !== "up") throw new RoomsError("room_down", `room '${name}' is ${st.state}; ${remedies.up(name)}`);
    const origin = signin ? new URL(signin).origin : undefined;
    const site = signin ? (await rooms.sites(name)).find((s) => s.origin === origin) : undefined;
    let tab, release, ended = false;
    const end = async (reason) => {
      if (ended) return;
      ended = true;
      await release?.();
      await rooms.logEvent(name, "handoff.ended", { tab, reason, ...(origin && { origin }) });
    };
    const v = await viewer(name, { signin: signin ?? null, signedOut: site?.signedOut ?? DEFAULT_SIGNED_OUT, onSignedIn: () => end("signed_in"), log: (m) => console.error(m) });
    tab = `room:${name}:${v.targetId}`;
    release = await rooms.holdTab(name, v.targetId);
    await rooms.logEvent(name, "handoff.started", { tab, reason: signin ? "signin" : "view", ...(origin && { origin }) });
    out(v.url);
    if (!noOpen) spawnSync("open", [v.url]);
    try { await untilClosed(); }
    finally { await end("closed"); v.close(); }
    return 0;
  }
  try {
    switch (cmd) {
      case "site": {
        const [, sub, room, url] = argv;
        if (sub === "add") { const s = await rooms.siteAdd(room, url, opt(argv, "--signed-out") ? { signedOut: opt(argv, "--signed-out") } : {}); print(s); return 0; }
        if (sub === "list") { print(await rooms.sites(room)); return 0; }
        out(USAGE); return 2;
      }
      case "set": {
        const settings = Object.fromEntries(argv.slice(2).map((kv) => { const i = kv.indexOf("="); return i > 0 ? [kv.slice(0, i), kv.slice(i + 1)] : [kv, undefined]; }));
        if (!Object.keys(settings).length) { out(USAGE); return 2; }
        print(await rooms.set(name, settings)); return 0;
      }
      case "flags": {
        const [, sub, room, ...flags] = argv;
        if (sub === "set") { print(await rooms.flagsSet(room, flags)); return 0; }
        if (sub === "list") { print(await rooms.flags(room)); return 0; }
        out(USAGE); return 2;
      }
      case "check": {
        const r = await rooms.check(name);
        if (json) print(r);
        else for (const s of r) out(`${{ signed_in: "signed in ", signed_out: "SIGNED OUT", unknown: "UNKNOWN   " }[s.state]} ${s.origin}${s.signedIn && s.expires ? `  until ${s.expires.slice(0, 10)}` : ""}${s.remedy ? `  -> ${s.remedy}` : ""}`);
        return r.every((s) => s.signedIn) ? 0 : 1;
      }
      case "signin": {
        if (!argv.includes("--from")) return await view(name, argv[2], argv.includes("--no-open"));
        const sites = argv.slice(2).filter((a, i, all) => a !== "--from" && all[i - 1] !== "--from").flatMap((s) => s.split(",")).filter(Boolean);
        const copied = { ...await rooms.teleport(name, { from: opt(argv, "--from"), sites }), copiedOnly: "cookies" };
        if (!json) out(`Copied ${copied.copied} cookies${copied.hosts ? ` for ${copied.hosts.join(", ")}` : ""}. Cookies only: passwords, local storage and other site data stay in the browser.`);
        // With sites to check, find out now which ones the cookies didn't sign in.
        if (!(await rooms.sites(name)).length) {
          if (json) print(copied); else out(`Next: ${remedies.up(name)}; rooms site add ${name} <https-url>; rooms check ${name}`);
          return 0;
        }
        await rooms.up(name);
        const checked = await rooms.check(name);
        const missing = checked.filter((s) => s.state !== "signed_in");
        if (json) print({ ...copied, check: checked });
        else if (!missing.length) out("Every site is signed in.");
        else for (const s of missing) out(`${s.state === "unknown" ? "couldn't check" : "still needs a sign-in"}: ${s.origin}  -> ${s.remedy}`);
        return missing.length ? 1 : 0;
      }
      case "teleport": { // older name for signin --from
        const sites = opt(argv, "--sites")?.split(",");
        const r = await rooms.teleport(name, { from: opt(argv, "--from"), sites });
        print(r);
        if (!json) out(`Next: ${remedies.up(name)}; rooms check ${name}`);
        return 0;
      }
      case "snapshot": {
        const [, sub, room, id] = argv;
        const call = { save: "checkpoint", list: "checkpoints", restore: "restore", delete: "prune" }[sub];
        if (!call) { out(USAGE); return 2; }
        print(await (call === "checkpoints" ? rooms.checkpoints(room) : rooms[call](room, id))); return 0;
      }
      // Older names for snapshot save|list|restore|delete.
      case "checkpoint": print(await rooms.checkpoint(name, argv[2])); return 0;
      case "checkpoints": print(await rooms.checkpoints(name)); return 0;
      case "restore": print(await rooms.restore(name, argv[2])); return 0;
      case "prune": print(await rooms.prune(name, argv[2])); return 0;
      // doctor is the older name for status --deep.
      case "doctor": { const d = await rooms.doctor(name); report(d); return d.ok ? 0 : 1; }
      case "autostart": {
        const enabled = { on: true, off: false, "--remove": false, undefined: true }[argv[2]];
        if (enabled === undefined) { out(USAGE); return 2; }
        print(await rooms.autostart(name, enabled)); return 0;
      }
      case "watch": {
        const claim = await rooms.claimWatch(name);
        if (!claim.claimed) { print({ name, state: "watched", by: claim.pid }); return 0; }
        if (argv.includes("--start")) {
          const d = await rooms.doctor(name);
          if (d.code === "room_down" && !d.stopRequested) await rooms.up(name);
        }
        let stopped = false, last = null;
        const stop = () => { stopped = true; };
        process.once("SIGINT", stop); process.once("SIGTERM", stop);
        try {
          while (!stopped) {
            try {
              const u = await rooms.update();
              if (u.state === "promoted" || u.state === "build_failed") print(u);
            } catch (e) { print({ name, state: "error", code: e.code ?? "update_failed", error: e.message }); }
            try {
              const r = await rooms.heartbeat(name);
              if (r.state !== last || r.state === "restarted") print(r);
              last = r.state;
            } catch (e) { print({ name, state: "error", code: e.code ?? "watch_failed", error: e.message }); last = "error"; }
            if (!stopped) await new Promise((resolve) => {
              const done = () => { clearTimeout(timer); process.off("SIGINT", done); process.off("SIGTERM", done); resolve(); };
              const timer = setTimeout(done, 30000);
              process.once("SIGINT", done); process.once("SIGTERM", done);
            });
          }
        } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
        return 0;
      }
      case "view": return await view(name, opt(argv, "--signin"), argv.includes("--no-open"));
      case "init": {
        const r = await rooms.init(name);
        if (json) print({ name: r.name, profile: r.profile, port: r.cdp.port });
        else out(`room ${r.name}: profile ${r.profile}, CDP 127.0.0.1:${r.cdp.port}. Next: ${remedies.up(r.name)}`);
        return 0;
      }
      case "up": print(await rooms.up(name)); return 0;
      case "update": print(await rooms.update({ force: true })); return 0;
      case "down": print(await rooms.down(name)); return 0;
      case "status": {
        if (!name || name.startsWith("--")) { print(await rooms.list()); return 0; }
        if (argv.includes("--deep")) { const d = await rooms.doctor(name); report(d); return d.ok ? 0 : 1; }
        const s = await rooms.status(name);
        print(s);
        return s.state === "up" ? 0 : 1;
      }
      case "list": print(await rooms.list()); return 0; // older name for status
      case "rotate": print(await rooms.rotate(name)); return 0;
      case "logs": {
        // --follow prints new events as they come; --until <event> also stops at the first such
        // event logged after the command started, so an agent can wait for, say, handoff.ended.
        // New events are found after the last one printed, which survives the log's rotation.
        const until = opt(argv, "--until");
        let last = null, first = true, stop = false;
        const onSignal = () => { stop = true; };
        process.once("SIGINT", onSignal);
        try {
          for (;;) {
            const events = await rooms.events(name);
            const keys = events.map((e) => JSON.stringify(e));
            const from = last === null ? 0 : keys.lastIndexOf(last) + 1;
            for (const e of events.slice(from)) { print(e); if (until && !first && e.event === until) return 0; }
            if (keys.length) last = keys.at(-1);
            first = false;
            if (!argv.includes("--follow") || stop) return 0;
            await sleep(1000);
          }
        } finally { process.off("SIGINT", onSignal); }
      }
      case "endpoint": out(argv.includes("--ws") ? await browserWsUrl(rooms.endpoint(name)) : rooms.endpoint(name)); return 0;
      default: out(USAGE); return 2;
    }
  } catch (e) {
    if (e instanceof RoomsError) { console.error(e.message); return 1; }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
