// The memory guard (guard.mjs), on a fake /proc: it ends the heaviest renderer only when the room's
// available memory is under the floor, one per tick, and never the browser or another process.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startGuard, heaviestRenderer } from "../guard.mjs";
import { tmpHome } from "./helpers.mjs";

function fakeProc(procs, { total = 3072, available = 1500 } = {}) {
  const proc = tmpHome();
  const mem = (mb) => writeFileSync(join(proc, "meminfo"), `MemTotal:       ${total * 1024} kB\nMemFree:          1000 kB\nMemAvailable:   ${mb * 1024} kB\n`);
  mem(available);
  for (const [pid, type, mb] of procs) {
    mkdirSync(join(proc, String(pid)));
    // The browser's arguments are NUL-separated; its children's are one space-joined title.
    writeFileSync(join(proc, String(pid), "cmdline"), type ? `/usr/lib/chromium/chromium --type=${type} --user-data-dir=/profile\0` : "/usr/lib/chromium/chromium\0--user-data-dir=/profile\0");
    writeFileSync(join(proc, String(pid), "status"), `Name:\tchromium\nVmRSS:\t  ${mb * 1024} kB\n`);
  }
  mkdirSync(join(proc, "self")); // not a pid
  return { proc, mem };
}
const PROCS = [[10, null, 900], [11, "gpu-process", 800], [12, "renderer", 300], [13, "renderer", 1200], [14, "utility", 50], [15, "renderer-like", 2000]];

test("the heaviest renderer is picked, never the browser, GPU or a utility process", () => {
  assert.deepEqual(heaviestRenderer(fakeProc(PROCS).proc), { pid: 13, kb: 1200 * 1024 });
  assert.equal(heaviestRenderer(fakeProc([[10, null, 900]]).proc), null);
});

test("nothing is ended while memory is above the floor; below it, one renderer per tick, and the state says so", () => {
  const { proc, mem } = fakeProc(PROCS);
  const killed = [], lines = [];
  const g = startGuard({ proc, everyMs: 1e9, kill: (pid) => killed.push(pid), now: () => Date.parse("2026-11-11T20:00:00Z"), log: (l) => lines.push(l) });
  try {
    assert.deepEqual(g.state, { totalMb: 3072, availableMb: 1500, ended: 0, last: null });
    mem(308); g.tick(); // a tenth of 3072 is 307.2
    assert.deepEqual(killed, []);
    mem(200); g.tick();
    assert.deepEqual(killed, [13]);
    assert.deepEqual(g.state, { totalMb: 3072, availableMb: 200, ended: 1, last: { at: "2026-11-11T20:00:00.000Z", mb: 1200, availableMb: 200 } });
    assert.match(lines[0], /200 MB of 3072 MB left; ended the heaviest tab \(1200 MB\)/);
    mem(900); g.tick();
    assert.deepEqual(killed, [13], "memory came back: nothing more is ended");
  } finally { g.stop(); }
});

test("a renderer that can't be ended, or a /proc that can't be read, changes nothing", () => {
  const { proc } = fakeProc(PROCS, { available: 100 });
  const g = startGuard({ proc, everyMs: 1e9, kill: () => { throw new Error("ESRCH"); }, log: () => {} });
  try { assert.equal(g.state.ended, 0); } finally { g.stop(); }
  const none = startGuard({ proc: join(proc, "missing"), everyMs: 1e9, kill: () => assert.fail("killed"), log: () => {} });
  try { assert.deepEqual(none.state, { totalMb: null, availableMb: null, ended: 0, last: null }); } finally { none.stop(); }
});

test("a small room keeps 256 MB: thrashing starts near 100 MB whatever the room's size", () => {
  const { proc, mem } = fakeProc(PROCS, { total: 1024, available: 257 });
  const killed = [];
  const g = startGuard({ proc, everyMs: 1e9, kill: (pid) => killed.push(pid), log: () => {} });
  try {
    assert.deepEqual(killed, []);
    mem(255); g.tick();
    assert.deepEqual(killed, [13]);
  } finally { g.stop(); }
});
