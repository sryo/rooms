#!/usr/bin/env node
// rooms' bench: what starting a room and checking its sites cost, counted with the test fakes (no container,
// no browser), and the lines of code. Writes a run in fium's format (RULES.md K2) and prints its path last.
//   node bench/run.mjs [out.json]     default: ~/.fium/runs/rooms/<commit>[-dirty].json
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(join(ROOT, p)).href);
const { createRooms } = await load("rooms.mjs");
const { connectCdp } = await load("cdp.mjs");
const { fakeRuntime, fakeFetch } = await load("test/helpers.mjs");
const { FakeChrome } = await load("test/fake-cdp.mjs");

const home = mkdtempSync(join(tmpdir(), "rooms-bench-"));
const runtime = fakeRuntime();
// One signed-in site, one that lands on its login page, one that redirects to another origin.
const chrome = new FakeChrome({ redirects: {
  "https://www.b.test/files": "https://www.b.test/login?next=files",
  "https://www.c.test/feed/": "https://accounts.c-id.test/signin",
} });
const rooms = createRooms({
  home, runtime, fetch: fakeFetch(), sleep: async () => {}, image: "rooms-chrome:bench", portBase: 9300,
  physicalMemory: 64 * 2 ** 30, launchAgents: join(home, "LaunchAgents"),
  connect: (url) => connectCdp(url, { WebSocket: chrome.WebSocket, timeoutMs: 500 }),
});

await rooms.init("bench");
for (const url of ["https://app.a.test/", "https://www.b.test/files", "https://www.c.test/feed/"]) await rooms.siteAdd("bench", url);
let n = runtime.calls.length;
await rooms.up("bench");
const upExec = runtime.calls.length - n;
n = chrome.log.length;
await rooms.check("bench");
const checkCdp = chrome.log.length - n;

// Non-blank lines of the code rooms runs, wherever it moves: everything but tests, the bench and docs.
const code = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (/^(\.|node_modules$|test$|bench$|docs$)/.test(e.name) ? [] : code(join(dir, e.name)))
  : /\.(mjs|js|sh)$/.test(e.name) ? [join(dir, e.name)] : []);
const loc = code(ROOT).reduce((sum, f) => sum + readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).length, 0);

const git = (...a) => { const r = spawnSync("git", ["-C", ROOT, ...a], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
const commit = git("rev-parse", "HEAD");
const dirty = commit ? git("status", "--porcelain") !== "" : false;
const m = (kind, x) => ({ dir: "lower", kind, samples: [x] });
const run = { commit, dirty, metrics: { "up exec calls": m("count", upExec), "check cdp calls": m("count", checkCdp), loc: m("loc", loc) } };

const runs = join(process.env.FIUM_HOME || join(homedir(), ".fium"), "runs", "rooms");
const out = process.argv[2] ?? join(runs, `${(commit ?? "unstamped").slice(0, 12)}${dirty ? "-dirty" : ""}.json`);
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, JSON.stringify(run, null, 1) + "\n");
console.log(out);
