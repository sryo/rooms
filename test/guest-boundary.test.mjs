// The profile is mounted read-write into the guest, so anything in it may be a link the guest
// planted. Host-side rooms must never write, truncate or delete through one.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRooms } from "../rooms.mjs";
import { tmpHome, fakeRuntime, fakeFetch } from "./helpers.mjs";

const make = () => {
  const home = tmpHome(), runtime = fakeRuntime();
  const rooms = createRooms({ home, runtime, fetch: fakeFetch(), sleep: async () => {}, physicalMemory: 64 * 2 ** 30, connect: async () => { throw new Error("no cdp"); } });
  return { home, runtime, rooms };
};
const victim = (home, name = "victim.txt") => { const p = join(home, "..", `${home.split("/").at(-1)}-${name}`); writeFileSync(p, "precious"); return p; };

test("down never writes through a stop marker the guest replaced with a link", async () => {
  const { home, rooms } = make();
  const r = await rooms.init("work");
  await rooms.up("work");
  const target = victim(home);
  symlinkSync(target, join(r.profile, ".rooms-stop"));
  await rooms.down("work");
  assert.equal(readFileSync(target, "utf8"), "precious");
});

test("up never writes flags through a link the guest planted", async () => {
  const { home, rooms } = make();
  const r = await rooms.init("work");
  await rooms.flagsSet("work", ["--touch-events=enabled"]);
  const target = victim(home);
  symlinkSync(target, join(r.profile, ".rooms-flags"));
  await rooms.up("work");
  assert.equal(readFileSync(target, "utf8"), "precious");
});

test("down never deletes inside a folder the guest linked in as Default", async () => {
  const { home, rooms } = make();
  const r = await rooms.init("work");
  await rooms.up("work");
  const outside = join(home, "..", `${home.split("/").at(-1)}-outside`);
  mkdirSync(join(outside, "Code Cache"), { recursive: true });
  writeFileSync(join(outside, "Code Cache", "keep"), "precious");
  symlinkSync(outside, join(r.profile, "Default"));
  await rooms.down("work");
  assert.equal(readFileSync(join(outside, "Code Cache", "keep"), "utf8"), "precious");
});

test("the stop request and flags live in a host-owned folder the guest mounts read-only", async () => {
  const { home, runtime, rooms } = make();
  const r = await rooms.init("work");
  await rooms.flagsSet("work", ["--touch-events=enabled"]);
  await rooms.up("work");
  const run = runtime.calls.find((c) => c[0] === "run");
  const control = join(home, "control", "work");
  assert.ok(run.includes(`type=bind,source=${control},target=/rooms,readonly`));
  assert.equal(readFileSync(join(control, "flags"), "utf8"), "--touch-events=enabled\n");
  assert.equal(existsSync(join(r.profile, ".rooms-flags")), false);
  await rooms.down("work");
  assert.ok(existsSync(join(control, "stop")));
  assert.equal(existsSync(join(r.profile, ".rooms-stop")), false);
});
