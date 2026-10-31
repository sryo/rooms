// Tab leases, in perch's format and with its lock (perch/server.js roomLeaseChange): ~/.rooms/run/leases/
// <sha256 of the tabId>.json holds {owner, pid, last, active, held}, and <that file>.lock is a folder
// made atomically while one process changes it, taken over once older than five seconds.
// A lease holds its tab while its process lives and is mid-call (active) or within five seconds of
// one. The viewer's lease is owned by "user" and stays active until the viewer closes.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IDLE_MS = 5000;
export const leaseFile = (home, tabId) => join(home, "run", "leases", createHash("sha256").update(tabId).digest("hex") + ".json");

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

async function change(home, tabId, update) {
  const path = leaseFile(home, tabId), lock = path + ".lock";
  mkdirSync(join(home, "run", "leases"), { recursive: true, mode: 0o700 });
  let held = false;
  for (let n = 0; n < 50 && !held; n++) {
    try { mkdirSync(lock, { mode: 0o700 }); held = true; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > IDLE_MS) rmSync(lock, { recursive: true, force: true }); } catch {}
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  if (!held) throw new Error("tab_held: room tab lease is busy; retry");
  try {
    let state = null;
    try { state = JSON.parse(readFileSync(path, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const next = update(state);
    if (next === undefined) return state;
    if (next === null) rmSync(path, { force: true });
    else {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      renameSync(tmp, path);
    }
    return state;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

export function leaseHolder(home, tabId) {
  let s;
  try { s = JSON.parse(readFileSync(leaseFile(home, tabId), "utf8")); } catch { return null; }
  if (!s || !alive(s.pid) || !(s.active || Date.now() - s.last < IDLE_MS)) return null;
  return { owner: s.owner, pid: s.pid };
}

// Takes the tab for the user, over any agent's lease (the person at the viewer wins); returns the
// release, which removes the lease only while it is still this one.
export async function holdForUser(home, tabId, pid = process.pid) {
  const since = new Date().toISOString();
  await change(home, tabId, () => ({ owner: "user", pid, last: Date.now(), active: true, held: null, since }));
  return () => change(home, tabId, (s) => (s?.owner === "user" && s.pid === pid && s.since === since ? null : undefined));
}
