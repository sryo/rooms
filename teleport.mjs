// Move selected Chrome cookies into a stopped room profile. Cookie values stay in memory;
// the source database is snapshotted with SQLite's backup API while Chrome may be running.
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const IV = Buffer.alloc(16, 0x20);
const PREFIX = Buffer.from("v10");
export const chromeKey = (password, iterations) => pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
export const ROOM_KEY = chromeKey("peanuts", 1);

export function encryptCookie(value, key, host, version) {
  const plain = Buffer.from(value, "utf8");
  const body = version >= 24 ? Buffer.concat([createHash("sha256").update(host).digest(), plain]) : plain;
  const cipher = createCipheriv("aes-128-cbc", key, IV);
  return Buffer.concat([PREFIX, cipher.update(body), cipher.final()]);
}

export function decryptCookie(blob, key, host, version) {
  if (!Buffer.isBuffer(blob) && !(blob instanceof Uint8Array)) throw new Error("cookie has no encrypted value");
  const bytes = Buffer.from(blob);
  if (!bytes.subarray(0, 3).equals(PREFIX)) throw new Error("unsupported cookie encryption version");
  const decipher = createDecipheriv("aes-128-cbc", key, IV);
  const plain = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]);
  if (version < 24) return plain.toString("utf8");
  const hash = createHash("sha256").update(host).digest();
  if (!plain.subarray(0, hash.length).equals(hash)) throw new Error("cookie host hash did not match");
  return plain.subarray(hash.length).toString("utf8");
}

export const cookieFile = (profile) => {
  for (const path of [join(profile, "Network", "Cookies"), join(profile, "Cookies")]) if (existsSync(path)) return path;
  return null;
};

// Not the full Public Suffix List: the ccTLD second levels and shared hosting domains people are
// likely to type. Naming one would copy the cookies of every site under it.
const CC_SECOND_LEVELS = new Set(["ac", "co", "com", "edu", "gob", "gov", "gv", "ltd", "mil", "ne", "net", "nom", "or", "org", "plc", "sch"]);
const SHARED_HOSTS = new Set([
  "appspot.com", "azurewebsites.net", "blogspot.com", "cloudfront.net", "firebaseapp.com", "fly.dev", "github.io",
  "gitlab.io", "glitch.me", "herokuapp.com", "netlify.app", "ngrok-free.app", "ngrok.io", "onrender.com", "pages.dev",
  "s3.amazonaws.com", "vercel.app", "web.app", "workers.dev",
]);
const isPublicSuffix = (host) => {
  if (SHARED_HOSTS.has(host)) return true;
  const labels = host.split(".");
  return labels.length === 2 && CC_SECOND_LEVELS.has(labels[0]) && /^[a-z]{2}$/.test(labels[1]);
};

export function siteNames(sites) {
  if (!Array.isArray(sites) || !sites.length) throw new Error("no_sites: name at least one site");
  return sites.map((s) => {
    if (typeof s !== "string" || !/^[a-z0-9.-]+$/i.test(s)) throw new Error(`bad_site: invalid site '${s}'`);
    const host = s.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    if (!host.includes(".") || host.includes("..") || host.startsWith("-") || host.endsWith("-")) throw new Error(`bad_site: invalid site '${s}'`);
    if (isPublicSuffix(host)) throw new Error(`public_suffix: '${s}' is shared by many sites; name the site itself, like example.${host}`);
    return host;
  });
}

const matches = (host, sites) => sites.some((site) => {
  const h = host.toLowerCase().replace(/^\./, "");
  return h === site || h.endsWith(`.${site}`);
});
const version = (db) => Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value);
const columns = (db) => db.prepare("PRAGMA table_info(cookies)").all().map((r) => r.name);

export async function copyCookies({ sourceProfile, roomProfile, sites, password }) {
  const selected = siteNames(sites);
  const sourcePath = cookieFile(sourceProfile);
  const roomPath = cookieFile(roomProfile);
  if (!sourcePath) throw new Error("source_profile_missing: source Cookies database is missing");
  if (!roomPath) throw new Error("room_never_started: the room has no Cookies database; start and stop it once");
  const scratch = mkdtempSync(join(tmpdir(), "rooms-teleport-"));
  chmodSync(scratch, 0o700);
  const snapshotPath = join(scratch, "Cookies");
  let source, snapshot, room;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    await backup(source, snapshotPath);
    source.close(); source = null;
    chmodSync(snapshotPath, 0o600);
    snapshot = new DatabaseSync(snapshotPath, { readOnly: true, readBigInts: true });
    room = new DatabaseSync(roomPath);
    const sourceVersion = version(snapshot), roomVersion = version(room);
    if (!Number.isInteger(sourceVersion) || !Number.isInteger(roomVersion) || sourceVersion < 23 || roomVersion < 23)
      throw new Error("cookie_schema: unsupported database version");
    const sourceCols = columns(snapshot), roomCols = columns(room);
    if (!sourceCols.includes("host_key") || !sourceCols.includes("encrypted_value") || !roomCols.includes("encrypted_value"))
      throw new Error("cookie_schema: required cookie columns are missing");
    const copyCols = roomCols.filter((c) => sourceCols.includes(c));
    const rows = snapshot.prepare(`SELECT ${sourceCols.map((c) => `"${c}"`).join(",")} FROM cookies`).all()
      .filter((r) => matches(r.host_key, selected));
    // Decrypt and transform before opening a write transaction. A bad key or a new encryption
    // version must leave every existing room cookie intact.
    const sourceKey = chromeKey(password, 1003);
    const converted = rows.map((r) => {
      const value = r.encrypted_value?.length
        ? decryptCookie(r.encrypted_value, sourceKey, r.host_key, sourceVersion)
        : r.value;
      if (typeof value !== "string") throw new Error("cookie_value: a selected cookie has no value");
      return { ...r, value: "", encrypted_value: encryptCookie(value, ROOM_KEY, r.host_key, roomVersion) };
    });
    const quoted = copyCols.map((c) => `"${c}"`).join(",");
    const insert = room.prepare(`INSERT OR REPLACE INTO cookies (${quoted}) VALUES (${copyCols.map(() => "?").join(",")})`);
    room.exec("BEGIN IMMEDIATE");
    try {
      for (const r of converted) insert.run(...copyCols.map((c) => r[c]));
      room.exec("COMMIT");
    } catch (e) { room.exec("ROLLBACK"); throw e; }
    return { copied: converted.length, hosts: [...new Set(converted.map((r) => r.host_key))].sort() };
  } finally {
    room?.close(); snapshot?.close(); source?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}
