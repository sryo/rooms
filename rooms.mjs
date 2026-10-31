#!/usr/bin/env node
// rooms: long-lived minimal Chrome rooms for perch.
// A room is one container (Apple `container`, a lightweight Linux VM) running one Chromium on one
// persistent profile, with CDP reachable on host loopback through a token relay (relay.mjs).
// The profile path is fixed per room and is created only by `init`; nothing here ever makes a
// fresh profile behind the user's back (a fresh profile is a signed-out one).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, rmSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectCdp, browserWsUrl } from "./cdp.mjs";
import { cloneFile as apfsClone, checkpointProfile, restoreProfile } from "./checkpoints.mjs";

export class RoomsError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}
const fail = (code, message) => { throw new RoomsError(code, message); };

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const GUEST_RELAY_PORT = 9223;
const VERSION = 1;
const DEFAULT_SIGNED_OUT = "(^|/)(login|log-in|signin|sign-in|sign_in|auth|session/new)([/?#]|$)";
const STOP_MARKER = ".rooms-stop";
const FLAGS_FILE = ".rooms-flags";
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
  };
}

function versionParts(s) {
  const m = String(s).trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) fail("profile_version", `invalid Chromium profile version '${String(s).trim()}'`);
  return m.slice(1).map(Number);
}
function newer(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
function sharedMemory(memory) {
  const m = /^(\d+)([GM])$/.exec(memory);
  if (!m) fail("bad_memory", `memory '${memory}' must be an integer count of G or M`);
  const mib = Number(m[1]) * (m[2] === "G" ? 1024 : 1);
  if (!Number.isSafeInteger(mib) || mib < 128) fail("bad_memory", "room memory must be at least 128M");
  const half = Math.min(2048, Math.floor(mib / 2));
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
    return { origin: s.origin, signedIn: !why, landed: loc.href, ...(why && { why }) };
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// While a room is up the Mac must not sleep (a sleeping Mac pauses the VM), but the display may
// sleep and the screen may lock: `caffeinate -i`, detached, its pid kept in run/<name>.awake.
// stop() checks the pid is still a caffeinate before killing it (pids are reused).
export const macAwake = {
  start() {
    const p = spawn("caffeinate", ["-i"], { detached: true, stdio: "ignore" });
    p.unref();
    return p.pid;
  },
  stop(pid) {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    if (/caffeinate/.test(r.stdout || "")) { try { process.kill(pid); } catch {} }
  },
};

export function createRooms({
  home = process.env.ROOMS_HOME || join(homedir(), ".rooms"),
  runtime = appleContainer(),
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  image = process.env.ROOMS_IMAGE || "rooms-chrome:latest",
  portBase = 9300,
  memory = "4G",
  shm = null,
  connect = (url) => connectCdp(url),
  awake = null, // the CLI passes macAwake; library users and tests hold nothing
  keychain = macKeychain,
  cloneFile = apfsClone,
  launchAgents = join(homedir(), "Library", "LaunchAgents"),
} = {}) {
  const file = join(home, "rooms.json");
  const containerName = (name) => `rooms-${name}`;
  const heartbeatFailures = new Map();
  const agentFile = (name) => join(launchAgents, `ai.perch.rooms.${name}.plist`);

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

  return {
    endpoint,

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
      return room;
    },

    async up(name, { timeoutMs = 60000 } = {}) {
      const room = get(name);
      if (!existsSync(room.profile)) fail("profile_missing", `${room.profile} is gone; restore it, or rooms init a new room (it starts signed out)`);
      if (!runtime.available()) fail("runtime_missing", "Apple's `container` CLI isn't installed or isn't running (brew install container; container system start)");
      const cname = containerName(name);
      const state = containers().get(cname);
      if (state === "running") fail("profile_in_use", `${cname} is already running on ${room.profile}`);
      const lastVersion = join(room.profile, "Last Version");
      if (existsSync(lastVersion) && runtime.imageVersion) {
        const profileVersion = readFileSync(lastVersion, "utf8").trim();
        const browserVersion = runtime.imageVersion(image);
        if (newer(profileVersion, browserVersion)) fail("profile_newer", `profile ${name} was used by Chromium ${profileVersion}; image ${image} has ${browserVersion}`);
      }
      if (state) runtime.exec(["delete", cname]); // a stopped leftover; the profile is on the host, so nothing is lost
      rmSync(join(room.profile, STOP_MARKER), { force: true });
      const flags = chromeFlags(room.flags ?? []);
      if (flags.length) writeFileSync(join(room.profile, FLAGS_FILE), flags.join("\n") + "\n", { mode: 0o600 });
      else rmSync(join(room.profile, FLAGS_FILE), { force: true });

      const envFile = join(home, "run", `${name}.env`);
      mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
      const downloads = join(home, "downloads", name);
      mkdirSync(downloads, { recursive: true, mode: 0o700 });
      writeFileSync(envFile, `ROOMS_TOKEN=${room.cdp.token}\n`, { mode: 0o600 });
      chmodSync(envFile, 0o600);

      const r = runtime.exec([
        "run", "--detach",
        "--name", cname,
        "--publish", `127.0.0.1:${room.cdp.port}:${GUEST_RELAY_PORT}`,
        "--volume", `${room.profile}:/profile`,
        "--volume", `${downloads}:/downloads`,
        "--env-file", envFile,
        "--memory", memory,
        "--shm-size", shm ?? sharedMemory(memory),
        "--label", `rooms.name=${name}`,
        image,
      ]);
      if (r.code !== 0) fail("runtime_error", `container run: ${r.stderr.trim()}`);

      const awakeFile = join(home, "run", `${name}.awake`);
      const holdAwake = () => {
        if (!awake) return;
        if (existsSync(awakeFile)) awake.stop(Number(readFileSync(awakeFile, "utf8")));
        const pid = awake.start();
        if (pid) writeFileSync(awakeFile, String(pid), { mode: 0o600 });
      };
      const t0 = Date.now();
      let last;
      for (;;) {
        try { const v = await probe(name); heartbeatFailures.delete(name); holdAwake(); return { name, state: "up", browser: v.Browser, endpoint: endpoint(name) }; }
        catch (e) { last = e; }
        if (Date.now() - t0 > timeoutMs) {
          runtime.exec(["stop", cname]);
          fail("health_timeout", `no CDP from ${cname} after ${timeoutMs} ms (${last?.message}); stopped it, profile kept`);
        }
        await sleep(500);
      }
    },

    async down(name) {
      const room = get(name);
      heartbeatFailures.delete(name);
      const cname = containerName(name);
      const state = containers().get(cname);
      if (state === "running") {
        // Tell the guest supervisor that Browser.close is deliberate before sending it.
        writeFileSync(join(room.profile, STOP_MARKER), "", { mode: 0o600 });
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
      const awakeFile = join(home, "run", `${name}.awake`);
      if (awake && existsSync(awakeFile)) { awake.stop(Number(readFileSync(awakeFile, "utf8"))); rmSync(awakeFile, { force: true }); }
      return { name, state: "down" };
    },

    async heartbeat(name, { after = 3 } = {}) {
      const room = get(name);
      if (!Number.isInteger(after) || after < 1) fail("bad_args", "heartbeat after must be a positive integer");
      if (!runtime.available()) fail("runtime_missing", "Apple's `container` CLI isn't available");
      if (containers().get(containerName(name)) !== "running") {
        heartbeatFailures.delete(name);
        return { name, state: "down", failures: 0 };
      }
      try {
        const v = await probe(name);
        heartbeatFailures.delete(name);
        return { name, state: "up", browser: v.Browser, failures: 0 };
      } catch {
        const failures = (heartbeatFailures.get(name) || 0) + 1;
        heartbeatFailures.set(name, failures);
        if (failures < after) return { name, state: "unhealthy", failures };
      }
      try {
        await this.down(name);
        await this.up(name);
        return { name, state: "restarted", profile: room.profile, failures: 0 };
      } catch (e) {
        fail("restart_failed", `room '${name}' could not restart (${e.message}); profile kept at ${room.profile}`);
      }
    },

    async doctor(name) {
      const room = get(name);
      if (!existsSync(room.profile)) return { name, ok: false, code: "profile_missing", profile: room.profile };
      if (!runtime.available()) return { name, ok: false, code: "runtime_missing", profile: room.profile };
      const state = containers().get(containerName(name));
      if (state !== "running") return { name, ok: false, code: "room_down", profile: room.profile };
      try { const v = await probe(name); return { name, ok: true, code: "healthy", browser: v.Browser, profile: room.profile }; }
      catch (e) { return { name, ok: false, code: "cdp_unhealthy", error: e.message, profile: room.profile }; }
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
      try { const v = await probe(name); return { name, state: "up", browser: v.Browser, endpoint: endpoint(name), profile: room.profile }; }
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
      save(reg);
      return flags;
    },
    async flags(name) { return get(name).flags ?? []; },

    async checkpoint(name, id = `cp-${Date.now().toString(36)}`) {
      const room = get(name);
      if (containers().get(containerName(name)) === "running") fail("room_up", `room '${name}' is up; rooms down ${name} first`);
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) fail("bad_checkpoint", "checkpoint names use lowercase letters, digits and dashes");
      if (!existsSync(room.profile)) fail("profile_missing", `room '${name}' profile is missing`);
      try { checkpointProfile(room.profile, join(home, "checkpoints", name, id), cloneFile); }
      catch (e) { const m = /^(checkpoint_exists|profile_missing): (.*)$/.exec(String(e.message)); fail(m?.[1] ?? "checkpoint_failed", m?.[2] ?? e.message); }
      return { name, id };
    },
    async checkpoints(name) {
      get(name);
      const path = join(home, "checkpoints", name);
      return existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => ({ id: x.name })).sort((a, b) => a.id.localeCompare(b.id)) : [];
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
      const path = join(home, "checkpoints", name, id);
      if (!existsSync(path)) fail("checkpoint_missing", `checkpoint '${id}' does not exist`);
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
      if (!cookieFile(roomProfile)) fail("room_never_started", `room '${name}' has no Cookies database; start and stop it once`);
      const alias = SOURCE_PROFILES[from];
      const sourceProfile = alias ? join(homedir(), "Library", "Application Support", alias[0], alias[1], "Default") : from;
      if (typeof sourceProfile !== "string" || !isAbsolute(sourceProfile)) fail("bad_source", "--from must be canary, chrome, or an absolute profile path");
      if (!cookieFile(sourceProfile)) fail("source_profile_missing", `no Cookies database in ${sourceProfile}`);
      const secret = keychain(alias?.[2] ?? "Chrome Safe Storage");
      if (typeof secret !== "string" || !secret) fail("keychain_denied", "the Chrome Safe Storage secret was not available");
      try { return await copyCookies({ sourceProfile, roomProfile, sites: selected, password: secret }); }
      catch (e) {
        const [code, ...rest] = String(e.message).split(": ");
        if (/^[a-z_]+$/.test(code) && rest.length) fail(code, rest.join(": "));
        fail("teleport_failed", `cookie transfer failed (${e.message}); the room profile was not partially updated`);
      }
    },

    async check(name, { loadMs = 20000, settleReads = 3 } = {}) {
      const room = get(name);
      const st = await this.status(name);
      if (st.state !== "up") fail("room_down", `room '${name}' is ${st.state}; rooms up ${name}`);
      const cdp = await connect(await browserWsUrl(endpoint(name), fetch));
      try {
        const out = [];
        for (const s of room.sites ?? []) {
          // Each site on its own: one that fails to load or keeps dropping its page is signed out
          // with an error, and the others are still checked.
          try { out.push(await checkSite(cdp, s, { loadMs, settleReads, sleep })); }
          catch (e) { out.push({ origin: s.origin, signedIn: false, error: e.message }); }
        }
        return out;
      } finally { cdp.close(); }
    },

    async list() {
      return Promise.all(Object.keys(load().rooms).sort().map((n) => this.status(n)));
    },
  };
}

// ---------- CLI ----------
const USAGE = `usage: rooms init <name> | up <name> | down <name> | status [<name>] | list
       rooms endpoint <name> [--ws]          CDP endpoint (http, or the browser ws URL)
       rooms site add <name> <https-url> [--signed-out <regex>] | site list <name>
       rooms check <name>                    which sites are still signed in (exit 1 if any isn't)
       rooms teleport <name> --from canary|chrome|<profile-path> --sites a.com,b.com
       rooms checkpoint <name> [<id>] | checkpoints <name> | restore <name> <id> | prune <name> <id>
       rooms doctor <name> | watch <name> [--start] | autostart <name> [--remove]
       rooms flags set <name> <flag>... | flags list <name>
       rooms view <name> [--signin <url>] [--no-open]   watch and drive the room; sign in once`;
const opt = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
export async function main(argv, rooms = createRooms({ awake: macAwake }), out = console.log) {
  const [cmd, name] = argv;
  try {
    switch (cmd) {
      case "site": {
        const [, sub, room, url] = argv;
        if (sub === "add") { const s = await rooms.siteAdd(room, url, opt(argv, "--signed-out") ? { signedOut: opt(argv, "--signed-out") } : {}); out(JSON.stringify(s)); return 0; }
        if (sub === "list") { out(JSON.stringify(await rooms.sites(room))); return 0; }
        out(USAGE); return 2;
      }
      case "flags": {
        const [, sub, room, ...flags] = argv;
        if (sub === "set") { out(JSON.stringify(await rooms.flagsSet(room, flags))); return 0; }
        if (sub === "list") { out(JSON.stringify(await rooms.flags(room))); return 0; }
        out(USAGE); return 2;
      }
      case "check": {
        const r = await rooms.check(name);
        for (const s of r) out(`${s.signedIn ? "signed in " : "SIGNED OUT"} ${s.origin}${s.signedIn ? "" : `  -> rooms view ${name} --signin ${s.origin}`}`);
        return r.every((s) => s.signedIn) ? 0 : 1;
      }
      case "teleport": {
        const sites = opt(argv, "--sites")?.split(",");
        const r = await rooms.teleport(name, { from: opt(argv, "--from"), sites });
        out(JSON.stringify(r));
        out(`Next: rooms up ${name}; rooms check ${name}`);
        return 0;
      }
      case "checkpoint": out(JSON.stringify(await rooms.checkpoint(name, argv[2]))); return 0;
      case "checkpoints": out(JSON.stringify(await rooms.checkpoints(name))); return 0;
      case "restore": out(JSON.stringify(await rooms.restore(name, argv[2]))); return 0;
      case "prune": out(JSON.stringify(await rooms.prune(name, argv[2]))); return 0;
      case "doctor": { const d = await rooms.doctor(name); out(JSON.stringify(d)); return d.ok ? 0 : 1; }
      case "autostart": out(JSON.stringify(await rooms.autostart(name, !argv.includes("--remove")))); return 0;
      case "watch": {
        if (argv.includes("--start")) {
          const d = await rooms.doctor(name);
          if (d.code === "room_down" && !existsSync(join(d.profile, STOP_MARKER))) await rooms.up(name);
        }
        let stopped = false, last = null;
        const stop = () => { stopped = true; };
        process.once("SIGINT", stop); process.once("SIGTERM", stop);
        try {
          while (!stopped) {
            try {
              const r = await rooms.heartbeat(name);
              if (r.state !== last || r.state === "restarted") out(JSON.stringify(r));
              last = r.state;
            } catch (e) { out(JSON.stringify({ name, state: "error", code: e.code ?? "watch_failed", error: e.message })); last = "error"; }
            if (!stopped) await new Promise((resolve) => {
              const done = () => { clearTimeout(timer); process.off("SIGINT", done); process.off("SIGTERM", done); resolve(); };
              const timer = setTimeout(done, 30000);
              process.once("SIGINT", done); process.once("SIGTERM", done);
            });
          }
        } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
        return 0;
      }
      case "view": {
        const { startViewer } = await import("./view.mjs");
        const st = await rooms.status(name);
        if (st.state !== "up") throw new RoomsError("room_down", `room '${name}' is ${st.state}; rooms up ${name}`);
        const v = await startViewer({ wsUrl: await browserWsUrl(rooms.endpoint(name)), connect: (u) => connectCdp(u), signin: opt(argv, "--signin") ?? null, log: (m) => console.error(m) });
        out(v.url);
        if (!argv.includes("--no-open")) spawnSync("open", [v.url]);
        await new Promise((r) => { process.once("SIGINT", r); process.once("SIGTERM", r); });
        v.close();
        return 0;
      }
      case "init": { const r = await rooms.init(name); out(`room ${r.name}: profile ${r.profile}, CDP 127.0.0.1:${r.cdp.port}. Next: rooms up ${r.name}`); return 0; }
      case "up": out(JSON.stringify(await rooms.up(name))); return 0;
      case "down": out(JSON.stringify(await rooms.down(name))); return 0;
      case "status": out(JSON.stringify(name ? await rooms.status(name) : await rooms.list())); return 0;
      case "list": out(JSON.stringify(await rooms.list())); return 0;
      case "endpoint": out(argv.includes("--ws") ? await browserWsUrl(rooms.endpoint(name)) : rooms.endpoint(name)); return 0;
      default: out(USAGE); return 2;
    }
  } catch (e) {
    if (e instanceof RoomsError) { console.error(e.message); return 1; }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => process.exit(c));
