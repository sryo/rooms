// install.sh, run against a temp HOME with stubs for brew, container and npm that log their
// calls: it installs container when missing, builds the image once, links the CLI, and a second
// run pulls instead of cloning and leaves the image alone. No real build, no real HOME.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpHome } from "./helpers.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const installer = join(repo, "install.sh");

// container's stub keeps its images as files under $STUB_STATE; brew's puts container on PATH.
const CONTAINER = `#!/bin/bash
echo "container $*" >> "$STUB_LOG"
case "$1 $2" in
  "image inspect") [[ -f "$STUB_STATE/image-$3" ]] || { echo "not found" >&2; exit 1; } ;;
  "build --no-cache") touch "$STUB_STATE/image-$4" ;;
esac
`;
const BREW = `#!/bin/bash
echo "brew $*" >> "$STUB_LOG"
[[ "$*" == "install container" ]] && cp "$STUB_STATE/container" "$STUB_BIN/container"
exit 0
`;
const NPM = `#!/bin/bash
echo "npm $* (in $PWD)" >> "$STUB_LOG"
`;

// PATH is the stubs plus /usr/bin and /bin, so no real brew, container or npm can be reached.
function sandbox({ brew = true, container = false } = {}) {
  const root = tmpHome(), home = join(root, "home"), bin = join(root, "bin"), state = join(root, "state");
  for (const d of [home, bin, state]) mkdirSync(d);
  const put = (path, body) => { writeFileSync(path, body); chmodSync(path, 0o755); };
  put(join(state, "container"), CONTAINER);
  if (container) put(join(bin, "container"), CONTAINER);
  if (brew) put(join(bin, "brew"), BREW);
  put(join(bin, "npm"), NPM);
  symlinkSync(process.execPath, join(bin, "node"));
  const log = join(root, "calls.log");
  const run = (env = {}) => {
    const r = spawnSync("bash", [installer], {
      encoding: "utf8",
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ROOMS_REPO: `file://${repo}`, STUB_LOG: log, STUB_BIN: bin, STUB_STATE: state, ...env },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    writeFileSync(log, "");
    return { code: r.status, out: r.stdout + r.stderr, calls };
  };
  return { home, run, dir: join(home, ".rooms", "src") };
}

const darwin = process.platform === "darwin";

test("a first run installs container, starts it, builds the image, stops the builder and links the CLI, in that order", { skip: !darwin }, () => {
  const { run, dir } = sandbox();
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, [
    "brew install container",
    "container system start",
    "container image inspect rooms-chrome:latest",
    "container build --no-cache -t rooms-chrome:latest -f image/Dockerfile .",
    "container builder stop",
    `npm link (in ${dir})`,
  ]);
  assert.ok(existsSync(join(dir, ".git")) && existsSync(join(dir, "rooms.mjs")), "cloned into ROOMS_DIR's default");
  assert.match(r.out, /rooms init <name>[\s\S]*rooms up <name>[\s\S]*rooms signin <name> <url>/, "the next steps, in README's order");
});

test("a second run pulls instead of cloning and skips the build; ROOMS_REBUILD=1 builds again", { skip: !darwin }, () => {
  const { run, dir } = sandbox();
  assert.equal(run().code, 0);
  writeFileSync(join(dir, "kept.tmp"), "");
  const again = run();
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /pulling/);
  assert.doesNotMatch(again.out, /Cloning/);
  assert.ok(existsSync(join(dir, "kept.tmp")), "the checkout is the same one");
  assert.deepEqual(again.calls, ["container system start", "container image inspect rooms-chrome:latest", `npm link (in ${dir})`]);
  const rebuild = run({ ROOMS_REBUILD: "1" });
  assert.equal(rebuild.code, 0, rebuild.out);
  assert.ok(rebuild.calls.includes("container build --no-cache -t rooms-chrome:latest -f image/Dockerfile ."));
  assert.ok(rebuild.calls.includes("container builder stop"));
});

test("ROOMS_DIR moves the checkout; with no container and no brew it stops and says how to get container", { skip: !darwin }, () => {
  const moved = sandbox({ container: true });
  const at = join(moved.home, "elsewhere");
  assert.equal(moved.run({ ROOMS_DIR: at }).code, 0);
  assert.ok(existsSync(join(at, "rooms.mjs")));
  const bare = sandbox({ brew: false });
  const r = bare.run();
  assert.notEqual(r.code, 0);
  assert.match(r.out, /github\.com\/apple\/container\/releases/);
  assert.deepEqual(r.calls, []);
  assert.equal(existsSync(bare.dir), false, "nothing cloned before the prerequisites pass");
});
