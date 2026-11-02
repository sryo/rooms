// Pins bench/run.mjs: it counts what an up and a check cost with the fakes, writes a run fium can judge,
// and one more container exec in starting a room reads as worse in `fium compare`.
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpHome } from "./helpers.mjs";

const ROOT = join(import.meta.dirname, "..");
const FIUM = join(homedir(), "Documents", "fium", "fium");

// A copy of the code outside git, so its runs are unstamped and fium keeps none of them.
const copy = () => {
  const dir = tmpHome();
  for (const f of readdirSync(ROOT).filter((f) => f.endsWith(".mjs"))) cpSync(join(ROOT, f), join(dir, f));
  for (const d of ["bench", "test"]) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
  return dir;
};
const bench = (dir) => {
  const r = spawnSync(process.execPath, [join(dir, "bench", "run.mjs"), join(dir, "run.json")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const path = r.stdout.trim().split("\n").at(-1);
  return { path, run: JSON.parse(readFileSync(path, "utf8")) };
};

test("the bench writes a run in fium's format with the fakes' counts and the lines of code", () => {
  const { run } = bench(copy());
  assert.equal(run.commit, null);
  for (const name of ["up exec calls", "check cdp calls", "loc"]) {
    const m = run.metrics[name];
    assert.equal(m.dir, "lower");
    assert.equal(m.samples.length, 1);
    assert.ok(Number.isInteger(m.samples[0]) && m.samples[0] > 0, `${name}: ${m.samples}`);
  }
  assert.equal(run.metrics["up exec calls"].kind, "count");
  assert.equal(run.metrics.loc.kind, "loc");
});

test("the bench gives the same numbers twice", () => {
  const dir = copy();
  assert.deepEqual(bench(dir).run.metrics, bench(dir).run.metrics);
});

test("one more container exec in starting a room is worse in fium compare", { skip: !existsSync(FIUM) && "no fium" }, () => {
  const base = bench(copy());
  const dir = copy();
  const file = join(dir, "rooms.mjs");
  const src = readFileSync(file, "utf8");
  const at = "    const r = runtime.exec([\n      \"run\", \"--detach\",";
  assert.ok(src.includes(at));
  writeFileSync(file, src.replace(at, `    runtime.exec(["list", "--all"]);\n${at}`));
  const changed = bench(dir);
  assert.equal(changed.run.metrics["up exec calls"].samples[0], base.run.metrics["up exec calls"].samples[0] + 1);
  const r = spawnSync("python3", [FIUM, "compare", "--json", base.path, changed.path], { cwd: dir, encoding: "utf8" });
  const rows = Object.fromEntries(JSON.parse(r.stdout).map((x) => [x.metric, x.verdict]));
  assert.equal(rows["up exec calls"], "worse");
  assert.equal(rows["check cdp calls"], "same");
  assert.equal(r.status, 1);
});
