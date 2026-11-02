// SQLite owns the lock for as long as this connection holds its transaction.
// The OS releases it when a process exits, including when it crashes midway.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleeper = new Int32Array(new SharedArrayBuffer(4));

// A shared lock is a read transaction: any number of them hold together, and they keep out an exclusive one.
function tryAcquire(path, shared) {
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    if (shared) { db.exec("BEGIN"); db.prepare("SELECT count(*) FROM sqlite_master").get(); }
    else db.exec("BEGIN EXCLUSIVE");
    let held = true;
    return { release() {
      if (!held) return;
      held = false;
      try { db.exec("ROLLBACK"); } finally { db.close(); }
    } };
  } catch (e) {
    db.close();
    if (/database is locked/.test(e.message)) return null;
    throw e;
  }
}

export function acquireFileLockSync(path, { waitMs = 0, shared = false } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = tryAcquire(path, shared);
    if (lock || Date.now() >= deadline) return lock;
    Atomics.wait(sleeper, 0, 0, Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

export async function acquireFileLock(path, { waitMs = 0, shared = false } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = tryAcquire(path, shared);
    if (lock || Date.now() >= deadline) return lock;
    await pause(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}
