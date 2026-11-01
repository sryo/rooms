// A file lock excludes another process, and the OS releases it when the holder dies.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { acquireFileLock } from "../locks.mjs";
import { tmpHome } from "./helpers.mjs";

const locksUrl = new URL("../locks.mjs", import.meta.url).href;

test("a second process cannot take a held lock, and a killed holder releases it", async () => {
  const path = join(tmpHome(), "run", "held.sqlite");
  const code = `
    import { acquireFileLock } from ${JSON.stringify(locksUrl)};
    const lock = await acquireFileLock(process.argv[1]);
    if (!lock) throw new Error("failed to acquire first lock");
    process.stdout.write("held\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, path], { stdio: ["ignore", "pipe", "pipe"] });
  const childDone = once(child, "exit");
  let out = "", err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  try {
    const deadline = Date.now() + 3000;
    while (!out.includes("held\n") && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(out.includes("held\n"), err || "child did not acquire lock");
    assert.equal(await acquireFileLock(path), null);
    assert.equal(await acquireFileLock(path, { waitMs: 60 }), null);
  } finally {
    child.kill("SIGKILL");
    await childDone;
  }
  const next = await acquireFileLock(path, { waitMs: 500 });
  assert.ok(next, "the crashed holder's lock was released");
  next.release();
});

test("a waiting process acquires after release and release is idempotent", async () => {
  const path = join(tmpHome(), "run", "wait.sqlite");
  const first = await acquireFileLock(path);
  assert.ok(first);
  const code = `
    import { acquireFileLock } from ${JSON.stringify(locksUrl)};
    process.stdout.write("ready\\n");
    const lock = await acquireFileLock(process.argv[1], { waitMs: 2000 });
    if (!lock) throw new Error("timed out waiting for lock");
    process.stdout.write("held\\n");
    lock.release();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, path], { stdio: ["ignore", "pipe", "pipe"] });
  const childDone = once(child, "exit");
  let out = "", err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  try {
    const deadline = Date.now() + 3000;
    while (!out.includes("ready\n") && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(out.includes("ready\n"), err || "child did not start");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(!out.includes("held\n"));
  } finally { first.release(); first.release(); }
  const [exitCode] = await childDone;
  assert.equal(exitCode, 0, err);
  assert.ok(out.includes("held\n"));
});
