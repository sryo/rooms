// Each room's event log: one JSON line per thing that happened to it, in a host-owned file, so
// agents and people can see what happened and wait for what's next without a daemon.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRooms, main } from "../rooms.mjs";
import { appendEvent, readEvents } from "../events.mjs";
import { tmpHome, fakeRuntime, fakeFetch } from "./helpers.mjs";

const make = () => {
  const home = tmpHome();
  const rooms = createRooms({ home, runtime: fakeRuntime(), fetch: fakeFetch(), sleep: async () => {}, physicalMemory: 64 * 2 ** 30, connect: async () => { throw new Error("no cdp"); } });
  return { home, rooms };
};

test("up and down are logged in order, with a time, in the room's control folder", async () => {
  const { home, rooms } = make();
  await rooms.init("work");
  await rooms.up("work");
  await rooms.down("work");
  const events = await rooms.events("work");
  assert.deepEqual(events.map((e) => e.event), ["up", "down"]);
  assert.ok(events.every((e) => !Number.isNaN(Date.parse(e.at))));
  const file = join(home, "control", "work", "events.jsonl");
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("up logs how long it took from the start of up to CDP answering, in ms", async () => {
  let t = 1000;
  const rooms = createRooms({ home: tmpHome(), runtime: fakeRuntime(), fetch: fakeFetch(() => t >= 4000), sleep: async (ms) => { t += ms; }, now: () => t, physicalMemory: 64 * 2 ** 30, connect: async () => { throw new Error("no cdp"); } });
  await rooms.init("work");
  await rooms.up("work");
  const up = (await rooms.events("work")).find((e) => e.event === "up");
  assert.equal(up.ms, 3000);
});

test("the log is capped: past its size the older half moves aside once, and reading sees both", () => {
  const dir = tmpHome(), file = join(dir, "events.jsonl");
  for (let i = 0; i < 40; i++) appendEvent(file, "tick", { i }, { maxBytes: 400 });
  assert.ok(existsSync(file + ".1"));
  assert.ok(statSync(file).size <= 400 + 100);
  const seen = readEvents(file).map((e) => e.i);
  assert.equal(seen.at(-1), 39);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
});

test("rooms logs prints the log; --follow --until waits for an event and exits when it comes", async () => {
  const { rooms } = make();
  await rooms.init("work");
  await rooms.up("work");
  const lines = [];
  let ticks = 0;
  const waiting = main(["logs", "work", "--follow", "--until", "handoff.ended"], rooms, (l) => lines.push(l), {
    tty: false,
    sleep: async () => { if (++ticks === 2) await rooms.logEvent("work", "handoff.ended", { origin: "https://a.test" }); },
  });
  assert.equal(await waiting, 0);
  assert.deepEqual(lines.map((l) => JSON.parse(l).event), ["up", "handoff.ended"]);
});

test("the watcher logs a restart after a crash and an idle stop", async () => {
  let failNext = 0, idleMs = 0;
  const fetch = async (url) => { if (failNext > 0) { failNext--; throw new Error("ECONNREFUSED"); } return { ok: true, status: 200, json: async () => (url.endsWith("/rooms/activity") ? { idleMs } : { Browser: "Chromium/150.0" }) }; };
  const rooms = createRooms({ home: tmpHome(), runtime: fakeRuntime(), fetch, sleep: async () => {}, physicalMemory: 64 * 2 ** 30, connect: async () => { throw new Error("no cdp"); } });
  await rooms.init("work");
  await rooms.set("work", { idle: "1m" });
  await rooms.up("work");
  failNext = 1; // one failed probe; the restart's own probes answer
  assert.equal((await rooms.heartbeat("work", { after: 1 })).state, "restarted");
  idleMs = 120000;
  await rooms.heartbeat("work");
  const names = (await rooms.events("work")).map((e) => e.event);
  assert.ok(names.includes("crashed"), names.join(","));
  assert.equal(names.at(-1), "idle-down");
  assert.ok(names.indexOf("crashed") < names.lastIndexOf("up"));
});

test("while the viewer is open the user holds its tab; signin logs handoff.started, then handoff.ended once signed in", async () => {
  const { leaseHolder } = await import("../leases.mjs");
  const { home, rooms } = make();
  await rooms.init("work");
  await rooms.up("work");
  await rooms.siteAdd("work", "https://app.a.test/home");
  let signedIn, closeViewer, closed = false;
  const viewer = async (name, opts) => { signedIn = opts.onSignedIn; return { url: "http://127.0.0.1:1/v/x/", targetId: "T9", close: () => { closed = true; } }; };
  const running = main(["signin", "work", "https://app.a.test/home", "--no-open"], rooms, () => {}, { tty: false, viewer, untilClosed: () => new Promise((r) => { closeViewer = r; }) });
  while (!closeViewer) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(leaseHolder(home, "room:work:T9"), { owner: "user", pid: process.pid });
  let names = (await rooms.events("work")).map((e) => e.event);
  assert.equal(names.at(-1), "handoff.started");
  assert.equal((await rooms.events("work")).at(-1).origin, "https://app.a.test");
  await signedIn("https://app.a.test/dashboard");
  const ended = (await rooms.events("work")).at(-1);
  assert.deepEqual([ended.event, ended.reason, ended.tab], ["handoff.ended", "signed_in", "room:work:T9"]);
  assert.equal(leaseHolder(home, "room:work:T9"), null, "agents get the tab back once signed in");
  closeViewer();
  assert.equal(await running, 0);
  assert.ok(closed);
  names = (await rooms.events("work")).map((e) => e.event);
  assert.equal(names.filter((n) => n === "handoff.ended").length, 1);
});

test("a plain view also holds the tab, and closing it ends the handoff", async () => {
  const { leaseHolder } = await import("../leases.mjs");
  const { home, rooms } = make();
  await rooms.init("work");
  await rooms.up("work");
  let closeViewer;
  const viewer = async () => ({ url: "u", targetId: "T1", close: () => {} });
  const running = main(["view", "work", "--no-open"], rooms, () => {}, { tty: false, viewer, untilClosed: () => new Promise((r) => { closeViewer = r; }) });
  while (!closeViewer) await new Promise((r) => setTimeout(r, 5));
  assert.equal(leaseHolder(home, "room:work:T1").owner, "user");
  closeViewer();
  await running;
  assert.equal(leaseHolder(home, "room:work:T1"), null);
  const last = (await rooms.events("work")).at(-1);
  assert.deepEqual([last.event, last.reason], ["handoff.ended", "closed"]);
});
