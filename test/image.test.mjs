// The image can't be built here without Apple's `container`; these pin the contract the CLI and
// relay rely on, so a change to either side shows up as a failing test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const entry = readFileSync(new URL("../image/entrypoint.sh", import.meta.url), "utf8");
const docker = readFileSync(new URL("../image/Dockerfile", import.meta.url), "utf8");
const policyFile = new URL("../image/policies.json", import.meta.url);
const flag = (f) => assert.ok(entry.includes(f), `entrypoint lacks ${f}`);

test("entrypoint is valid sh", () => {
  assert.equal(spawnSync("sh", ["-n"], { input: entry }).status, 0);
});

test("Chromium uses the mounted profile and keeps DevTools on guest loopback", () => {
  flag("--user-data-dir=/profile");
  flag("--remote-debugging-address=127.0.0.1");
  flag('--remote-debugging-port="${ROOMS_CDP_PORT}"');
  assert.ok(!/remote-allow-origins=\*/.test(entry), "no wildcard origin");
});

test("refuses to start without a token or a mounted profile", () => {
  assert.match(entry, /ROOMS_TOKEN:-.*refusing/);
  assert.match(entry, /\[ -d \/profile \].*refusing/);
});

test("software WebGL is opted in (no GPU in the VM) and the anti-throttling flags are on", () => {
  for (const f of ["--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"]) flag(f);
});

test("Chromium reads per-room flags as whole lines from the mounted profile", () => {
  assert.match(entry, /\.rooms-flags/);
  assert.match(entry, /IFS= read -r flag/);
  assert.match(entry, /set -- "\$@" "\$flag"/);
  assert.match(entry, /chromium "\$@"/);
});

test("the relay runs and the image exposes only its port", () => {
  flag("node /opt/rooms/relay.mjs");
  assert.match(docker, /^EXPOSE 9223$/m);
  assert.ok(!/EXPOSE 9222/.test(docker));
  assert.match(docker, /COPY relay\.mjs \/opt\/rooms\/relay\.mjs/);
});

test("ports agree across Dockerfile, entrypoint and the CLI", async () => {
  assert.match(docker, /ROOMS_CDP_PORT=9222 ROOMS_RELAY_PORT=9223/);
  const cli = readFileSync(new URL("../rooms.mjs", import.meta.url), "utf8");
  assert.match(cli, /GUEST_RELAY_PORT = 9223/);
});

test("runs as a non-root user", () => {
  assert.match(docker, /^USER room$/m);
});

test("the image installs a managed policy that disables password saving and first-run promotions", () => {
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  assert.equal(policy.PasswordManagerEnabled, false);
  assert.equal(policy.PromotionalTabsEnabled, false);
  assert.match(docker, /COPY image\/policies\.json \/etc\/chromium\/policies\/managed\/rooms\.json/);
});

test("Chromium is restarted only after a crash: a clean exit (Browser.close on down) is not relaunched", () => {
  assert.match(entry, /rc=\$\?/);
  assert.match(entry, /\[ "\$rc" = 0 \]/);
  assert.match(entry, /\[ -e \/profile\/\.rooms-stop \]/);
  assert.ok(entry.indexOf("[ -e /profile/.rooms-stop ]") < entry.indexOf('if [ "$rc" = 0 ]'));
});

test("the relay and Xvfb are supervised: each runs in a restart loop", () => {
  assert.match(entry, /while :; do node \/opt\/rooms\/relay\.mjs/);
  assert.match(entry, /while :; do Xvfb :99/);
});
