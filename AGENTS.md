# rooms

How rooms is built and how to work on it. fium rules are in ~/Documents/fium/RULES.md. The README is for people using rooms; contracts and internals live here.

## Test
```bash
npm test
```

A change is done when `fium done` says so: it runs every How we know row of GOALS.md where the change started and now, and shows each number under its goal.

## Layout

```
.
├── rooms.mjs        # the CLI and the room lifecycle: init, up, down, status, check, view, watch, autostart
├── relay.mjs        # token relay in front of Chrome's DevTools server, inside the room
├── guard.mjs        # memory guard inside the room: ends the heaviest tab before the browser hangs
├── cdp.mjs          # CDP client with an allowlist of methods
├── view.mjs         # rooms view / rooms signin: the viewer page on host loopback
├── locks.mjs        # process-safe locks for room starts, image builds and registry edits
├── cookies.mjs      # signin --from: copies cookies from Chrome
├── checkpoints.mjs  # snapshot save/restore/list/delete
├── events.mjs       # control/<name>/events.jsonl
├── bench/           # run.mjs: what an up and a check cost, counted with the test fakes; judge, baseline
├── install.sh       # the one-command installer: container, clone to ~/.rooms/src, image build, npm link
├── image/           # the room's container image (Dockerfile, entrypoint, Chromium policies)
└── test/            # node:test, no container needed; each file opens with what it pins
```

## The ~/.rooms contract

Tools read `~/.rooms` directly. `test/contract.test.mjs` pins what they may rely on; fields may be added, none may move or change meaning.

- `rooms.json`: `version` 1, and `rooms.<name>` with `cdp.host`, `cdp.port` and `cdp.token` (the relay takes the token as the first path segment or as a Bearer header) and `sites[]` with `origin`, `url` and `signedOut`, a path pattern for a signed-out page.
- `downloads/<name>/` is the room's `/downloads`.
- `src/` is install.sh's checkout of rooms (`ROOMS_DIR` moves it); rooms doesn't read or write it.
- `run/leases/` and `run/claims/` are perch's own; rooms doesn't read or write them.
- `control/<name>/viewing/<targetId>.json` is `{pid, since}` while the user watches or drives that tab in the viewer; perch refuses the tab to agents while that pid lives. It goes when the viewer closes or the site signs in.
- `control/<name>/` is otherwise rooms' own: `token`, `events.jsonl` (one `{at, event, …}` per line, capped, the older half in `events.jsonl.1`), `owner.json` (who started the room, and when), `watcher.json` and `appearance` (`dark` or `light`: the Mac's when the room started, which the room's Chromium follows; `rooms status` shows it).
- `run/registry.lock.sqlite` serializes registry edits. `run/token-pending.json` records a token rotation until both the registry and the mounted token match; the next registry read completes one interrupted by a crash.
- `GET <port>/health` needs no token and answers `{ok, protocol}`. `GET <endpoint>/rooms/activity` answers `{idleMs}`, the time since a client last used the room. `GET <endpoint>/rooms/memory` answers `{totalMb, availableMb, ended, last}`: the room's memory, how many tabs the guard ended, and the last one (`{at, mb, availableMb}`); 404 on an image without the guard.
- After `rooms rotate`, the room's open connections close; read the token again from `rooms.json` and reconnect.

## Internals

- The room can write anything in its profile, so rooms never writes or deletes through what it finds there. Its own files live in `control/<name>/`, mounted read-only in the room. A room started from an image older than that mount ignores its `device` and `flags` settings and is never stopped for being idle, until the image is rebuilt and the room restarted.
- The viewer binds 127.0.0.1 on an ephemeral port and answers only requests whose Host is `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding); POSTs also need a same-origin `Origin`.
- `rooms autostart` installs a LaunchAgent that runs `rooms watch <name> --start`: it starts the room at login unless it was stopped on purpose, and restarts it after three failed heartbeats while its container runs. A restart that fails is retried (1 minute, doubling to 30) from `control/<name>/restart.json` until it works or someone runs `down`. A container that isn't running otherwise is left down.
- Each watcher also calls `update`, which builds the image at most once a day under `run/update.lock.sqlite` (state in `run/update.json`) and promotes the build when its Chromium is newer or the image's files changed. Heartbeat moves a room to a promoted build once it has been unused for an hour with nobody at the viewer, behind a `pre-update-*` checkpoint, and rolls back to it and `:previous` if the room doesn't start or loses a sign-in (`control/<name>/update.json` then skips that build).
- A room's VM has no swap, so a guest out of memory thrashes and its browser stops answering DevTools. `guard.mjs` runs in the relay's process: when less than 256 MB of the room's memory is available (a tenth, in a room over 2.5G) it kills the renderer with the largest resident set, one per one-second tick. That tab shows a crashed page; the browser and the other tabs keep answering. `rooms status` shows the guard's state as `memory`, and an `unhealthy` status carries a `remedy` saying the room may recover and how to check again. A room with `grow` set whose guard ended a tab is given 1G more at `down`, up to `grow` (event `grew`); the watcher keeps the guard's last count for a room too far gone to ask.
- A login agent runs with launchd's PATH, so `containerBin` also looks in Homebrew's folders. `status --deep` warns when the agent's file exists but no watcher is alive.
- `locks.mjs` holds SQLite transactions for process-safe exclusion. The OS releases a lock when its process dies; lock files remain on disk. Room starts, image builds, watcher claims and registry edits use separate lock files.
