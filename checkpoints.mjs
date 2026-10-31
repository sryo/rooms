// APFS copy-on-write profile snapshots. Call only while Chromium is stopped.
import { constants, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

// Ask APFS for a clone. Node falls back to a normal copy when the volume cannot clone
// (for example a temporary volume mounted without clonefile support).
export const cloneFile = (from, to) => copyFileSync(from, to, constants.COPYFILE_FICLONE);
const suffix = () => `${process.pid}-${randomBytes(4).toString("hex")}`;

function cloneTree(from, to, copy) {
  const st = lstatSync(from);
  if (st.isSymbolicLink()) { symlinkSync(readlinkSync(from), to); return; }
  if (st.isDirectory()) {
    mkdirSync(to, { mode: st.mode & 0o777 });
    for (const name of readdirSync(from)) cloneTree(join(from, name), join(to, name), copy);
    chmodSync(to, st.mode & 0o777);
    return;
  }
  if (!st.isFile()) throw new Error(`profile_entry: cannot clone special file ${from}`);
  copy(from, to);
  chmodSync(to, st.mode & 0o777);
}

export function checkpointProfile(profile, target, copy = cloneFile) {
  if (existsSync(target)) throw new Error("checkpoint_exists: this checkpoint already exists");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const staging = `${target}.${suffix()}.tmp`;
  try { cloneTree(profile, staging, copy); renameSync(staging, target); }
  finally { rmSync(staging, { recursive: true, force: true }); }
}

export function restoreProfile(profile, snapshot, replacedDir, copy = cloneFile) {
  if (!existsSync(snapshot)) throw new Error("checkpoint_missing: this checkpoint does not exist");
  if (!existsSync(profile)) throw new Error("profile_missing: the room profile is missing");
  mkdirSync(replacedDir, { recursive: true, mode: 0o700 });
  const id = `pre-restore-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const previous = join(replacedDir, id);
  const staging = `${profile}.restore-${suffix()}`;
  try {
    cloneTree(snapshot, staging, copy);
    renameSync(profile, previous);
    try { renameSync(staging, profile); }
    catch (e) { renameSync(previous, profile); throw e; }
    return previous;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
