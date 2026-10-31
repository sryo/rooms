import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRooms, RoomsError, main } from "../rooms.mjs";
import { chromeKey, encryptCookie, decryptCookie, ROOM_KEY } from "../teleport.mjs";
import { tmpHome, fakeRuntime, fakeFetch } from "./helpers.mjs";

const SCHEMA = `CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL);
CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port);`;

function cookiesDb(file, rows, key, version = 24) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(version));
  const ins = db.prepare("INSERT INTO cookies VALUES (1,?,'',?,'',?,'/',99,1,1,1,1,1,1,0,2,443,1,0,0)");
  for (const [host, name, value] of rows) ins.run(host, name, encryptCookie(value, key, host, version));
  db.close();
}
const read = (file, key) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const v = Number(db.prepare("SELECT value FROM meta WHERE key='version'").get().value);
  const out = db.prepare("SELECT host_key, name, encrypted_value FROM cookies ORDER BY host_key, name").all().map((r) => [r.host_key, r.name, decryptCookie(r.encrypted_value, key, r.host_key, v)]);
  db.close();
  return out;
};

function setup({ up = false, roomDb = true } = {}) {
  const home = tmpHome();
  const runtime = fakeRuntime();
  const rooms = createRooms({ home, runtime, fetch: fakeFetch(), sleep: async () => {}, keychain: (service) => (service === "Chrome Safe Storage" ? "mac-secret" : null) });
  const src = join(home, "src-profile", "Default", "Network");
  mkdirSync(src, { recursive: true });
  cookiesDb(join(src, "Cookies"), [
    [".b.test", "session", "gh-1"],
    ["boards.b.test", "_csrf", "gh-2"],
    [".bank.example", "auth", "never-moves"],
  ], chromeKey("mac-secret", 1003));
  return { home, runtime, rooms, srcProfile: join(home, "src-profile", "Default"), up, roomDb };
}
async function room(s, name = "work") {
  await s.rooms.init(name);
  if (s.roomDb) {
    const d = join(s.home, "profiles", name, "Default");
    mkdirSync(d, { recursive: true });
    cookiesDb(join(d, "Cookies"), [[".b.test", "session", "stale"], [".room-own.test", "x", "kept"]], ROOM_KEY);
  }
  if (s.up) await s.rooms.up(name);
}
const code = (p) => p.then(() => null, (e) => (e instanceof RoomsError ? e.code : e.message));

test("teleport copies only the named sites' cookies, re-encrypted for the room, and keeps the room's own", async () => {
  const s = setup();
  await room(s);
  const r = await s.rooms.teleport("work", { from: s.srcProfile, sites: ["b.test"] });
  assert.equal(r.copied, 2);
  assert.deepEqual(r.hosts, [".b.test", "boards.b.test"]);
  assert.deepEqual(read(join(s.home, "profiles", "work", "Default", "Cookies"), ROOM_KEY), [
    [".b.test", "session", "gh-1"],
    [".room-own.test", "x", "kept"],
    ["boards.b.test", "_csrf", "gh-2"],
  ]);
});

test("teleport never runs while the room is up (Chromium owns the profile)", async () => {
  const s = setup({ up: true });
  await room(s);
  assert.equal(await code(s.rooms.teleport("work", { from: s.srcProfile, sites: ["b.test"] })), "room_up");
});

test("teleport needs sites, and a room that has run once", async () => {
  const s = setup({ roomDb: false });
  await room(s);
  assert.equal(await code(s.rooms.teleport("work", { from: s.srcProfile, sites: [] })), "no_sites");
  assert.equal(await code(s.rooms.teleport("work", { from: s.srcProfile, sites: ["b.test"] })), "room_never_started");
});

test("a site name matches the domain and its subdomains, never a lookalike", async () => {
  const s = setup();
  await room(s);
  const r = await s.rooms.teleport("work", { from: s.srcProfile, sites: ["house.io"] });
  assert.equal(r.copied, 0);
  assert.equal(await code(s.rooms.teleport("work", { from: s.srcProfile, sites: ["example"] })), "bad_site");
});

test("the cookie crypto round-trips and binds the value to its host (DB version 24)", () => {
  const k = chromeKey("pw", 1003);
  const blob = encryptCookie("v", k, ".a.test", 24);
  assert.equal(blob.subarray(0, 3).toString(), "v10");
  assert.equal(decryptCookie(blob, k, ".a.test", 24), "v");
  assert.throws(() => decryptCookie(blob, k, ".b.test", 24), /host/);
  assert.equal(decryptCookie(encryptCookie("w", k, "h", 23), k, "h", 23), "w");
});

test("teleport preserves Chromium's microsecond timestamps outside JavaScript's safe integer range", async () => {
  const s = setup();
  await room(s);
  const source = new DatabaseSync(join(s.srcProfile, "Network", "Cookies"));
  const timestamp = 13437922944957903n;
  source.prepare("UPDATE cookies SET creation_utc = ? WHERE name = ?").run(timestamp, "session");
  source.close();
  await s.rooms.teleport("work", { from: s.srcProfile, sites: ["b.test"] });
  const target = new DatabaseSync(join(s.home, "profiles", "work", "Default", "Cookies"), { readOnly: true, readBigInts: true });
  assert.equal(target.prepare("SELECT creation_utc FROM cookies WHERE name = ?").get("session").creation_utc, timestamp);
  target.close();
});

test("a wrong Keychain secret leaves all room cookies unchanged", async () => {
  const s = setup();
  await room(s);
  const before = read(join(s.home, "profiles", "work", "Default", "Cookies"), ROOM_KEY);
  const wrong = createRooms({ home: s.home, runtime: s.runtime, fetch: fakeFetch(), keychain: () => "wrong-secret" });
  assert.equal(await code(wrong.teleport("work", { from: s.srcProfile, sites: ["b.test"] })), "teleport_failed");
  assert.deepEqual(read(join(s.home, "profiles", "work", "Default", "Cookies"), ROOM_KEY), before);
});

test("CLI parses a named source and site list without printing cookie values", async () => {
  let got;
  const output = [];
  const code = await main(["teleport", "work", "--from", "canary", "--sites", "a.com,b.com"], {
    teleport: async (name, options) => { got = { name, options }; return { copied: 2, hosts: ["a.com"] }; },
  }, (line) => output.push(line));
  assert.equal(code, 0);
  assert.deepEqual(got, { name: "work", options: { from: "canary", sites: ["a.com", "b.com"] } });
  assert.match(output.join("\n"), /"copied":2/);
  assert.doesNotMatch(output.join("\n"), /cookie|secret/i);
});
