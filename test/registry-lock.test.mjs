// Registry writes from separate rooms processes serialize, preserving every mutation and token file, including a start racing with rotation.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRooms } from "../rooms.mjs";
import { acquireFileLock } from "../locks.mjs";
import { tmpHome, fakeRuntime, fakeFetch } from "./helpers.mjs";

const roomsUrl = new URL("../rooms.mjs", import.meta.url).href;
const childCode = `
  import { createRooms } from ${JSON.stringify(roomsUrl)};
  const [home, op, arg] = process.argv.slice(1);
  const rooms = createRooms({ home });
  process.stdout.write("ready\\n");
  try {
    if (op === "init") await rooms.init(arg);
    if (op === "site") await rooms.siteAdd("work", arg);
    if (op === "rotate") await rooms.rotate("work");
    process.stdout.write("done\\n");
  } catch (e) { process.stderr.write(String(e.stack || e) + "\\n"); process.exitCode = 1; }
`;

function worker(home, op, arg = "") {
  const child = spawn(process.execPath, ["--input-type=module", "-e", childCode, home, op, arg], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const done = new Promise((resolve) => {
    child.once("exit", (code) => resolve({ code, output: out, error: err }));
  });
  const ready = new Promise((resolve, reject) => {
    const onData = () => { if (out.includes("ready\n")) { child.stdout.off("data", onData); resolve(); } };
    child.stdout.on("data", onData);
    child.once("exit", (code) => { if (!out.includes("ready\n")) reject(new Error(`worker exited ${code}: ${err}`)); });
    onData();
  });
  return { ready, done, output: () => out };
}

test("registry creation and site edits wait for the lock and preserve both processes' writes", async () => {
  const home = tmpHome();
  const rooms = createRooms({ home, runtime: fakeRuntime(), fetch: fakeFetch() });
  await rooms.init("work");
  const held = await acquireFileLock(join(home, "run", "registry.lock.sqlite"));
  assert.ok(held);
  const a = worker(home, "init", "other");
  const b = worker(home, "site", "https://example.test/home");
  try {
    await Promise.all([a.ready, b.ready]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!a.output().includes("done"));
    assert.ok(!b.output().includes("done"));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, "rooms.json"), "utf8")).rooms), ["work"]);
  } finally { held.release(); }
  for (const result of await Promise.all([a.done, b.done])) assert.equal(result.code, 0, result.error);
  const reg = JSON.parse(readFileSync(join(home, "rooms.json"), "utf8"));
  assert.deepEqual(Object.keys(reg.rooms).sort(), ["other", "work"]);
  assert.notEqual(reg.rooms.other.cdp.port, reg.rooms.work.cdp.port);
  assert.deepEqual(reg.rooms.work.sites.map((s) => s.origin), ["https://example.test"]);
});

test("concurrent token rotations leave the registry and relay token identical", async () => {
  const home = tmpHome();
  const rooms = createRooms({ home, runtime: fakeRuntime(), fetch: fakeFetch() });
  const prior = (await rooms.init("work")).cdp.token;
  const held = await acquireFileLock(join(home, "run", "registry.lock.sqlite"));
  assert.ok(held);
  const a = worker(home, "rotate");
  const b = worker(home, "rotate");
  try {
    await Promise.all([a.ready, b.ready]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(!a.output().includes("done"));
    assert.ok(!b.output().includes("done"));
  } finally { held.release(); }
  for (const result of await Promise.all([a.done, b.done])) assert.equal(result.code, 0, result.error);
  const token = JSON.parse(readFileSync(join(home, "rooms.json"), "utf8")).rooms.work.cdp.token;
  assert.notEqual(token, prior);
  assert.equal(readFileSync(join(home, "control", "work", "token"), "utf8"), token + "\n");
});

test("a read completes an interrupted token rotation before returning an endpoint", async () => {
  for (const registryAlreadySwapped of [false, true]) {
    const home = tmpHome();
    const rooms = createRooms({ home, runtime: fakeRuntime(), fetch: fakeFetch() });
    await rooms.init("work");
    const next = "a".repeat(48);
    const regPath = join(home, "rooms.json");
    if (registryAlreadySwapped) {
      const reg = JSON.parse(readFileSync(regPath, "utf8"));
      reg.rooms.work.cdp.token = next;
      writeFileSync(regPath, JSON.stringify(reg) + "\n", { mode: 0o600 });
    }
    const pending = join(home, "run", "token-pending.json");
    writeFileSync(pending, JSON.stringify({ name: "work", token: next }) + "\n", { mode: 0o600 });
    assert.ok(rooms.endpoint("work").endsWith(`/${next}`));
    assert.equal(JSON.parse(readFileSync(regPath, "utf8")).rooms.work.cdp.token, next);
    assert.equal(readFileSync(join(home, "control", "work", "token"), "utf8"), next + "\n");
    assert.equal(existsSync(pending), false);
  }
});

test("a rotation between up reading the room and writing its token leaves the rotated token mounted", async () => {
  const home = tmpHome();
  const runtime = fakeRuntime();
  let rotated = false;
  runtime.available = () => {
    if (!rotated) {
      rotated = true;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", childCode, home, "rotate"], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    return true;
  };
  const rooms = createRooms({ home, runtime, fetch: fakeFetch(), sleep: async () => {}, physicalMemory: 64 * 2 ** 30 });
  const prior = (await rooms.init("work")).cdp.token;
  await rooms.up("work");
  assert.ok(rotated);
  const token = JSON.parse(readFileSync(join(home, "rooms.json"), "utf8")).rooms.work.cdp.token;
  assert.notEqual(token, prior);
  assert.equal(readFileSync(join(home, "control", "work", "token"), "utf8"), token + "\n");
});
