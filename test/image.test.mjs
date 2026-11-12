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

test("Chromium reads per-room flags as whole lines from the read-only control mount", () => {
  assert.match(entry, /< \/rooms\/flags/);
  assert.match(entry, /IFS= read -r flag/);
  assert.match(entry, /set -- "\$@" "\$flag"/);
  assert.match(entry, /chromium "\$@"/);
});

test("Chromium starts dark when the host wrote a dark appearance, and light otherwise", () => {
  assert.match(entry, /\[ "\$\(cat \/rooms\/appearance 2>\/dev\/null\)" = dark \]; then set -- "\$@" --force-dark-mode; fi/);
  assert.ok(!/WebContentsForceDark|enable-force-dark/.test(entry), "pages choose their own dark styles; none is darkened by force");
});

test("the relay runs and the image exposes only its port", () => {
  flag("node /opt/rooms/relay.mjs");
  assert.match(docker, /^EXPOSE 9223$/m);
  assert.ok(!/EXPOSE 9222/.test(docker));
  assert.match(docker, /COPY relay\.mjs guard\.mjs \/opt\/rooms\/$/m, "the relay and the memory guard it starts");
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
  assert.match(entry, /\[ -e \/rooms\/stop \]/);
  assert.ok(entry.indexOf("[ -e /rooms/stop ]") < entry.indexOf('if [ "$rc" = 0 ]'));
});

test("the relay and Xvfb are supervised: each runs in a restart loop", () => {
  assert.match(entry, /while :; do node \/opt\/rooms\/relay\.mjs/);
  assert.match(entry, /while :; do Xvfb :99/);
});

test("the guest clears its own compiled-script cache before Chromium starts", () => {
  assert.match(entry, /rm -rf "\/profile\/Default\/Code Cache"/);
  assert.ok(entry.indexOf("Code Cache") < entry.indexOf('chromium "$@"'));
});

test("the policy keeps personal data and add-ons out of the room: no form autofill, no sync or browser sign-in, no extensions", () => {
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  assert.equal(policy.AutofillAddressEnabled, false);
  assert.equal(policy.AutofillCreditCardEnabled, false);
  assert.equal(policy.SyncDisabled, true);
  assert.equal(policy.BrowserSignin, 0);
  assert.deepEqual(policy.ExtensionInstallBlocklist, ["*"]);
});

test("the policy blocks notifications and the browser's own pages, but leaves pop-ups (OAuth sign-ins use them) and downloads alone", () => {
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  assert.equal(policy.DefaultNotificationsSetting, 2);
  assert.deepEqual(policy.URLBlocklist, ["chrome://*", "devtools://*"]);
  assert.equal(policy.DefaultPopupsSetting, undefined);
  assert.equal(policy.DownloadRestrictions, undefined);
});

test("the relay reads the token from the read-only control mount when it's there, else from the environment", () => {
  assert.match(entry, /\[ -s \/rooms\/token \]/);
  assert.match(entry, /export ROOMS_TOKEN_FILE=\/rooms\/token/);
});

test("caches live on the room's own disk, not in the profile mounted from the Mac", () => {
  flag("--disk-cache-dir=/tmp/rooms-cache");
  assert.ok(!/--disk-cache-dir=\/(profile|dev\/shm)/.test(entry), "not the profile, not RAM");
});

test("the graphics libraries SwiftShader doesn't use are removed in the layer that installs them", () => {
  const install = docker.split(/^RUN /m).find((r) => r.includes("apt-get install"));
  for (const lib of ["libllvm19", "mesa-libgallium", "libgl1-mesa-dri", "libz3-4"]) assert.ok(install.includes(lib), `the install layer doesn't remove ${lib}`);
});

test("a restart brings the room's tabs back, after a clean stop or a crash, and adds none", () => {
  assert.equal(JSON.parse(readFileSync(policyFile, "utf8")).RestoreOnStartup, 1);
  flag("--hide-crash-restore-bubble");
  assert.ok(!/chromium "\$@" about:blank/.test(entry), "a URL argument opens one more tab on every start");
});

test("the screen and the window take the room's size, 1440x900 when the host wrote none", () => {
  assert.match(entry, /size=\$\(cat \/rooms\/size 2>\/dev\/null \|\| true\)/, "a missing file must not end the script under set -e");
  assert.match(entry, /\[0-9\]\*x\[0-9\]\*\) ;; \*\) size=1440x900 ;;/, "anything else falls back");
  assert.match(entry, /Xvfb :99 -screen 0 "\$\{size\}x24"/);
  flag('--window-size="${size%x*},${size#*x}"');
  assert.ok(!entry.includes("1440,900") && !entry.includes("1440x900x24"), "no fixed size left");
});
