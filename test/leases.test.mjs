// Tab leases are perch's format (perch/server.js roomLeaseChange, withRoomLease), shared through
// ~/.rooms/run/leases: one file per tab, named by the sha256 of its tabId, with the same mkdir lock.
// rooms writes the "user" lease a viewer holds and reads leases to know a room is in use.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holdForUser, leaseHolder } from "../leases.mjs";
import { tmpHome } from "./helpers.mjs";

const file = (home, tabId) => join(home, "run", "leases", createHash("sha256").update(tabId).digest("hex") + ".json");

test("a viewer's lease is a perch lease owned by the user: active, with its pid, until released", async () => {
  const home = tmpHome();
  const release = await holdForUser(home, "room:work:T1");
  const s = JSON.parse(readFileSync(file(home, "room:work:T1"), "utf8"));
  assert.deepEqual([s.owner, s.pid, s.active, s.stuck, s.tabId], ["user", process.pid, true, null, "room:work:T1"]);
  assert.ok(!Number.isNaN(Date.parse(s.since)));
  assert.deepEqual(leaseHolder(home, "room:work:T1"), { owner: "user", pid: process.pid });
  await release();
  assert.equal(existsSync(file(home, "room:work:T1")), false);
  assert.equal(leaseHolder(home, "room:work:T1"), null);
});

test("an agent mid-call holds its tab; one between calls (inactive past five seconds) or one that exited doesn't", () => {
  const home = tmpHome();
  mkdirSync(join(home, "run", "leases"), { recursive: true });
  const put = (tabId, s) => writeFileSync(file(home, tabId), JSON.stringify(s));
  put("room:w:A", { owner: "x", pid: process.pid, last: Date.now(), active: true, stuck: null });
  put("room:w:B", { owner: "x", pid: process.pid, last: Date.now() - 60000, active: false, stuck: null });
  put("room:w:C", { owner: "x", pid: 999999, last: Date.now(), active: true, stuck: null });
  assert.deepEqual(leaseHolder(home, "room:w:A"), { owner: "x", pid: process.pid });
  assert.equal(leaseHolder(home, "room:w:B"), null);
  assert.equal(leaseHolder(home, "room:w:C"), null);
});

test("a lease whose pid now belongs to a process started after its last call holds nothing", () => {
  const home = tmpHome();
  mkdirSync(join(home, "run", "leases"), { recursive: true });
  const started = Date.now() - 60000;
  const put = (tabId, last) => writeFileSync(file(home, tabId), JSON.stringify({ owner: "x", pid: process.pid, last, active: true, stuck: null }));
  put("room:w:old", started - 3600000);
  put("room:w:now", Date.now());
  assert.equal(leaseHolder(home, "room:w:old", () => started), null, "the pid was reused");
  assert.deepEqual(leaseHolder(home, "room:w:now", () => started), { owner: "x", pid: process.pid });
  assert.deepEqual(leaseHolder(home, "room:w:old", () => null), { owner: "x", pid: process.pid }, "start time unknown: as before");
  assert.equal(leaseHolder(home, "room:w:old"), null, "this test process started after that lease's last call");
});

test("releasing never removes a lease someone else took over meanwhile", async () => {
  const home = tmpHome();
  const release = await holdForUser(home, "room:work:T1");
  writeFileSync(file(home, "room:work:T1"), JSON.stringify({ owner: "agent", pid: process.pid, last: Date.now(), active: true, stuck: null }));
  await release();
  assert.equal(JSON.parse(readFileSync(file(home, "room:work:T1"), "utf8")).owner, "agent");
});

test("the viewer keeps an agent's stuck key or button, and leaves it for the next holder to release", async () => {
  const home = tmpHome();
  const stuck = { type: "mouse", point: { x: 3, y: 4 } };
  mkdirSync(join(home, "run", "leases"), { recursive: true });
  writeFileSync(file(home, "room:work:T1"), JSON.stringify({ owner: "agent", pid: process.pid, last: Date.now(), active: false, stuck, tabId: "room:work:T1" }));
  const release = await holdForUser(home, "room:work:T1");
  assert.deepEqual(JSON.parse(readFileSync(file(home, "room:work:T1"), "utf8")).stuck, stuck);
  await release();
  const left = JSON.parse(readFileSync(file(home, "room:work:T1"), "utf8"));
  assert.deepEqual(left.stuck, stuck);
  assert.equal(left.tabId, "room:work:T1");
  assert.equal(left.owner, undefined);
  assert.equal(left.pid, undefined);
  assert.equal(left.active, false);
  assert.equal(leaseHolder(home, "room:work:T1"), null);
});
