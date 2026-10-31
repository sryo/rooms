import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tmpHome = () => mkdtempSync(join(tmpdir(), "rooms-"));

// A fake `container` CLI: records every argv, keeps a table of containers.
export function fakeRuntime({ missing = false } = {}) {
  const calls = [];
  const containers = new Map(); // name -> { running }
  return {
    calls,
    containers,
    available: () => !missing,
    exec(argv) {
      calls.push(argv);
      const [cmd, ...rest] = argv;
      if (cmd === "run") {
        const name = rest[rest.indexOf("--name") + 1];
        if (containers.has(name)) return { code: 1, stdout: "", stderr: `container ${name} already exists` };
        containers.set(name, { running: true });
        return { code: 0, stdout: name + "\n", stderr: "" };
      }
      if (cmd === "stop") { const c = containers.get(rest.at(-1)); if (c) c.running = false; return { code: 0, stdout: "", stderr: "" }; }
      if (cmd === "delete") { containers.delete(rest.at(-1)); return { code: 0, stdout: "", stderr: "" }; }
      if (cmd === "list") {
        return { code: 0, stdout: JSON.stringify([...containers].map(([id, c]) => ({ configuration: { id }, status: { state: c.running ? "running" : "stopped" } }))), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `fake: unknown ${cmd}` };
    },
  };
}

// fetch stand-in for the health check: answers /json/version once `ready()` is true.
export function fakeFetch(ready = () => true) {
  const seen = [];
  const fn = async (url) => {
    seen.push(url);
    if (!ready()) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200, json: async () => ({ Browser: "Chromium/150.0", webSocketDebuggerUrl: "ws://x/devtools/browser/abc" }) };
  };
  fn.seen = seen;
  return fn;
}
