// perch doesn't run the CLI: it reads rooms.json and the folders below directly. These pin what it
// reads (perch/server.js roomRegistry, roomHandoff, the downloads path), so a change that would break
// it fails here first. Fields may be added; none of these may move or change meaning.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRooms } from "../rooms.mjs";
import { tmpHome, fakeRuntime, fakeFetch } from "./helpers.mjs";

const make = () => {
  const home = tmpHome(), runtime = fakeRuntime();
  const rooms = createRooms({ home, runtime, fetch: fakeFetch(), sleep: async () => {}, physicalMemory: 64 * 2 ** 30 });
  return { home, runtime, rooms };
};

test("rooms.json: version 1, rooms by name, each with its CDP host, port and token", async () => {
  const { home, rooms } = make();
  await rooms.init("work");
  const reg = JSON.parse(readFileSync(join(home, "rooms.json"), "utf8"));
  assert.equal(reg.version, 1);
  const r = reg.rooms.work;
  assert.equal(r.name, "work");
  assert.equal(r.cdp.host, "127.0.0.1");
  assert.ok(Number.isInteger(r.cdp.port));
  assert.match(r.cdp.token, /^[0-9a-f]{48}$/);
  assert.equal(statSync(join(home, "rooms.json")).mode & 0o777, 0o600);
});

test("rooms.json: each site has its origin, the URL checked, and the signed-out path pattern", async () => {
  const { home, rooms } = make();
  await rooms.init("work");
  await rooms.siteAdd("work", "https://www.figma.com/files");
  const [s] = JSON.parse(readFileSync(join(home, "rooms.json"), "utf8")).rooms.work.sites;
  assert.deepEqual(Object.keys(s).sort(), ["origin", "signedOut", "url"]);
  assert.equal(s.origin, "https://www.figma.com");
  assert.ok(new RegExp(s.signedOut, "i").test("/login"));
});

test("the relay takes the token as the first path segment, so a URL alone is enough to connect", async () => {
  const { rooms } = make();
  const r = await rooms.init("work");
  assert.equal(rooms.endpoint("work"), `http://127.0.0.1:${r.cdp.port}/${r.cdp.token}`);
});

test("a room's downloads land in downloads/<name> on the Mac, mounted at /downloads in the room", async () => {
  const { home, runtime, rooms } = make();
  await rooms.init("work");
  await rooms.up("work");
  const run = runtime.calls.find((c) => c[0] === "run");
  assert.ok(run.includes(`${join(home, "downloads", "work")}:/downloads`));
  assert.ok(existsSync(join(home, "downloads", "work")));
});

test("run/ belongs to tools like perch (its tab leases live in run/leases); rooms keeps its own control files elsewhere", async () => {
  const { home, rooms } = make();
  await rooms.init("leases"); // a room may even be named like perch's folder
  await rooms.up("leases");
  await rooms.down("leases");
  assert.equal(existsSync(join(home, "run", "leases")), false);
  assert.ok(existsSync(join(home, "control", "leases", "stop")));
});

// perch spells this pattern too (ROOM_LOGIN_PATH in perch/server.js, pinned by its test/room.test.mjs);
// change both together.
test("the default signed-out path pattern is the one perch uses", async () => {
  const { DEFAULT_SIGNED_OUT } = await import("../rooms.mjs");
  assert.equal(DEFAULT_SIGNED_OUT, "(^|/)(login|log-in|signin|sign-in|sign_in|auth|session/new)([/?#]|$)");
});

test("AGENTS.md's layout names every module at the root", () => {
  const root = new URL("..", import.meta.url).pathname;
  const layout = readFileSync(join(root, "AGENTS.md"), "utf8");
  const missing = readdirSync(root).filter((f) => f.endsWith(".mjs") && !layout.includes(`── ${f}`));
  assert.deepEqual(missing, []);
});
