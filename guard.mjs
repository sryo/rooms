// Memory guard, inside the room. A room's VM has no swap, so a guest that runs out of memory
// thrashes instead of failing: Chromium stops answering DevTools and the room is dead until it is
// restarted. Before that point this ends the renderer holding the most memory (its tab shows a
// crashed page and reloads on its next navigation), so the browser and every other tab keep
// answering. The relay serves `state` as GET /rooms/memory.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const kb = (text, key) => { const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text); return m ? Number(m[1]) : null; };

// The renderer with the largest resident set, or null: {pid, kb}.
export function heaviestRenderer(proc = "/proc") {
  let best = null;
  for (const pid of readdirSync(proc)) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      // Chromium rewrites its children's titles, so their arguments are joined by spaces, not NULs.
      if (!/(^|[\s\0])--type=renderer([\s\0]|$)/.test(readFileSync(join(proc, pid, "cmdline"), "utf8"))) continue;
      const rss = kb(readFileSync(join(proc, pid, "status"), "utf8"), "VmRSS");
      if (rss != null && (!best || rss > best.kb)) best = { pid: Number(pid), kb: rss };
    } catch {} // the process ended between the listing and the read
  }
  return best;
}

// The floor is what must stay available: 256 MB, or a tenth of a larger room. Thrashing starts
// near 100 MB whatever the room's size (seen live: a 1G room stopped answering at 68 MB), since
// what gets squeezed out is Chromium's own code. Below the floor each tick ends one renderer; the
// next tick reads memory again, so a single heavy tab costs a single tab.
export function startGuard({ proc = "/proc", floorMb = 256, floorShare = 0.1, everyMs = 1000, kill = (pid) => process.kill(pid, "SIGKILL"), now = Date.now, log = console.error } = {}) {
  const state = { totalMb: null, availableMb: null, ended: 0, last: null };
  const tick = () => {
    let info;
    try { info = readFileSync(join(proc, "meminfo"), "utf8"); } catch { return; }
    const total = kb(info, "MemTotal"), available = kb(info, "MemAvailable");
    if (!total || available == null) return;
    state.totalMb = Math.round(total / 1024); state.availableMb = Math.round(available / 1024);
    if (available >= Math.max(floorMb * 1024, floorShare * total)) return;
    const r = heaviestRenderer(proc);
    if (!r) return;
    try { kill(r.pid); } catch { return; }
    state.ended++;
    state.last = { at: new Date(now()).toISOString(), mb: Math.round(r.kb / 1024), availableMb: state.availableMb };
    log(`rooms: ${state.availableMb} MB of ${state.totalMb} MB left; ended the heaviest tab (${state.last.mb} MB)`);
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return { state, tick, stop: () => clearInterval(timer) };
}
