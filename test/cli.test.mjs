// The command line as people and agents type it: each command reaches the right call, and the
// older names keep working, since perch still prints `restore`.
import test from "node:test";
import assert from "node:assert/strict";
import { main, remedies } from "../rooms.mjs";

// A rooms stand-in that records each call and answers with what the test gives it.
function spy(answers = {}) {
  const calls = [];
  const rooms = new Proxy({}, { get: (_, k) => k === "calls" ? calls : (...a) => { calls.push([k, ...a]); const v = answers[k]; return Promise.resolve(typeof v === "function" ? v(...a) : v); } });
  return rooms;
}
const run = async (argv, rooms = spy(), { tty = false } = {}) => {
  const lines = [];
  const exit = await main(argv, rooms, (l) => lines.push(l), { tty });
  return { exit, lines, calls: rooms.calls };
};

test("signin --from copies the named sites' sessions from a browser; teleport is no longer a command", async () => {
  const a = await run(["signin", "work", "--from", "chrome", "github.com", "linear.app"], spy({ copyCookies: { copied: 3 }, sites: [] }));
  assert.deepEqual(a.calls[0], ["copyCookies", "work", { from: "chrome", sites: ["github.com", "linear.app"] }]);
  assert.equal(a.exit, 0);
  const b = await run(["teleport", "work", "--from", "canary", "--sites", "a.com,b.com"]);
  assert.deepEqual([b.exit, b.calls], [2, []]);
  assert.doesNotMatch(b.lines.join("\n"), /teleport/);
});

test("the remedy for a signed-out site is the signin command", () => {
  assert.equal(remedies.signin("work", "https://www.figma.com/files"), "rooms signin work https://www.figma.com/files");
});

test("snapshot save|list|restore|delete; checkpoint, checkpoints, restore and prune still work", async () => {
  const pairs = [
    [["snapshot", "save", "work", "before"], ["checkpoint", "work", "before"]],
    [["snapshot", "save", "work"], ["checkpoint", "work", undefined]],
    [["snapshot", "list", "work"], ["checkpoints", "work"]],
    [["snapshot", "restore", "work", "before"], ["restore", "work", "before"]],
    [["snapshot", "delete", "work", "before"], ["prune", "work", "before"]],
    [["checkpoint", "work", "before"], ["checkpoint", "work", "before"]],
    [["checkpoints", "work"], ["checkpoints", "work"]],
    [["restore", "work", "before"], ["restore", "work", "before"]],
    [["prune", "work", "before"], ["prune", "work", "before"]],
  ];
  for (const [argv, call] of pairs) assert.deepEqual((await run(argv, spy({ checkpoints: [] }))).calls[0], call, argv.join(" "));
  assert.equal((await run(["snapshot", "rename", "work"])).exit, 2);
});

test("status: every room, or one room with a nonzero exit unless it's up; --deep adds the doctor's checks; list and doctor still work", async () => {
  const rooms = () => spy({ list: [{ name: "a", state: "up" }], status: (n) => ({ name: n, state: n === "a" ? "up" : "down" }), doctor: (n) => ({ name: n, ok: n === "a", code: n === "a" ? "healthy" : "room_down" }) });
  const all = await run(["status"], rooms());
  assert.deepEqual([all.calls[0][0], all.exit], ["list", 0]);
  assert.equal((await run(["status", "a"], rooms())).exit, 0);
  assert.equal((await run(["status", "b"], rooms())).exit, 1);
  const deep = await run(["status", "b", "--deep"], rooms());
  assert.deepEqual([deep.calls[0], deep.exit], [["doctor", "b"], 1]);
  assert.equal((await run(["list"], rooms())).calls[0][0], "list");
  assert.deepEqual((await run(["doctor", "a"], rooms())).calls[0], ["doctor", "a"]);
});

test("autostart on|off; bare autostart and --remove still work", async () => {
  for (const [argv, enabled] of [[["autostart", "work", "on"], true], [["autostart", "work", "off"], false], [["autostart", "work"], true], [["autostart", "work", "--remove"], false]]) {
    assert.deepEqual((await run(argv, spy({ autostart: {} }))).calls[0], ["autostart", "work", enabled], argv.join(" "));
  }
  assert.equal((await run(["autostart", "work", "maybe"])).exit, 2);
});

test("output is for people in a terminal and JSON when piped or asked for with --json", async () => {
  const rooms = () => spy({ list: [{ name: "a", state: "up", since: "2026-10-31T12:00:00Z", port: 9300 }, { name: "b", state: "down" }] });
  const human = await run(["status"], rooms(), { tty: true });
  assert.deepEqual(human.lines, ["a  up  since=2026-10-31T12:00:00Z  port=9300", "b  down"]);
  const piped = await run(["status"], rooms(), { tty: false });
  assert.equal(JSON.parse(piped.lines.join("")).length, 2);
  const asked = await run(["status", "--json"], rooms(), { tty: true });
  assert.equal(JSON.parse(asked.lines.join("")).length, 2);
});

test("status --deep in a terminal prints one line per check, with its fix", async () => {
  const d = { name: "w", ok: false, code: "room_down", checks: [{ id: "profile", status: "pass", severity: "required" }, { id: "container", status: "fail", severity: "required", remedy: "rooms up w" }] };
  const r = await run(["status", "w", "--deep"], spy({ doctor: d }), { tty: true });
  assert.deepEqual(r.lines, ["w  room_down", "  pass  profile", "  FAIL  container  -> rooms up w"]);
  assert.equal(r.exit, 1);
});

test("signin --from says it copied cookies only, then starts the room, checks it and names what still needs a sign-in", async () => {
  const check = [{ origin: "https://a.test", state: "signed_in" }, { origin: "https://b.test", state: "signed_out", remedy: "rooms signin work https://b.test/" }];
  const rooms = spy({ copyCookies: { copied: 4, hosts: [".a.test", ".b.test"] }, sites: [{ origin: "https://a.test" }], up: { state: "up" }, check });
  const r = await run(["signin", "work", "--from", "chrome", "a.test", "b.test"], rooms, { tty: true });
  assert.deepEqual(rooms.calls.map((c) => c[0]), ["copyCookies", "sites", "up", "check"]);
  assert.match(r.lines.join("\n"), /cookies only/i);
  assert.match(r.lines.join("\n"), /still needs a sign-in: https:\/\/b\.test  -> rooms signin work https:\/\/b\.test\//);
  assert.equal(r.exit, 1);
  const json = await run(["signin", "work", "--from", "chrome", "a.test"], spy({ copyCookies: { copied: 1 }, sites: [], up: { state: "up" } }));
  assert.deepEqual(JSON.parse(json.lines.join("")), { copied: 1, copiedOnly: "cookies" });
});

test("check says until when each signed-in site stays signed in", async () => {
  const r = await run(["check", "work"], spy({ check: [
    { origin: "https://github.com", state: "signed_in", signedIn: true, expires: "2026-12-01T10:00:00.000Z" },
    { origin: "https://linear.app", state: "signed_in", signedIn: true, expires: null },
    { origin: "https://figma.com", state: "signed_out", signedIn: false, expires: "2026-11-02T00:00:00.000Z", remedy: "rooms signin work https://figma.com" },
  ] }), { tty: true });
  assert.match(r.lines[0], /^signed in +https:\/\/github\.com +until 2026-12-01$/);
  assert.match(r.lines[1], /^signed in +https:\/\/linear\.app$/);
  assert.doesNotMatch(r.lines[2], /until/);
});
