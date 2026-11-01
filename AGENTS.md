# rooms

How rooms is built and how to work on it. fium rules are in ~/Documents/fium/RULES.md. The README is for people using rooms; contracts and internals live here.

## Test
```bash
npm test
```

## Layout

```
.
├── rooms.mjs        # the CLI and the room lifecycle: init, up, down, status, check, view, watch, autostart
├── relay.mjs        # token relay in front of Chrome's DevTools server, inside the room
├── cdp.mjs          # CDP client with an allowlist of methods
├── view.mjs         # rooms view / rooms signin: the viewer page on host loopback
├── leases.mjs       # tab leases shared with perch
├── cookies.mjs      # signin --from: copies cookies from Chrome
├── checkpoints.mjs  # snapshot save/restore/list/delete
├── events.mjs       # control/<name>/events.jsonl
├── image/           # the room's container image (Dockerfile, entrypoint, Chromium policies)
└── test/            # node:test, no container needed; each file opens with what it pins
```

## The ~/.rooms contract

Tools read `~/.rooms` directly. `test/contract.test.mjs` and `test/leases.test.mjs` pin what they may rely on; fields may be added, none may move or change meaning.

- `rooms.json`: `version` 1, and `rooms.<name>` with `cdp.host`, `cdp.port` and `cdp.token` (the relay takes the token as the first path segment or as a Bearer header) and `sites[]` with `origin`, `url` and `signedOut`, a path pattern for a signed-out page.
- `downloads/<name>/` is the room's `/downloads`.
- `run/leases/<sha256 of the tabId>.json` is a tab's lease, in perch's format: `{owner, pid, last, active, stuck, tabId}`, changed only while holding the folder `<that file>.lock` (taken over after five seconds). A lease holds its tab while its process lives and it is `active` or `last` is under five seconds old. `stuck` is a key or button its holder left pressed; it stays on the lease until the next holder releases it. The viewer's lease has `owner: "user"`; when it closes with input still stuck, it leaves the lease ownerless rather than deleting it.
- `run/claims/` is perch's own; rooms doesn't read or write it.
- `control/<name>/` is rooms' own: `token`, `events.jsonl` (one `{at, event, …}` per line, capped, the older half in `events.jsonl.1`), `owner.json` (who started the room, and when) and `watcher.json`.
- `GET <port>/health` needs no token and answers `{ok, protocol}`. `GET <endpoint>/rooms/activity` answers `{idleMs}`, the time since a client last used the room.
- After `rooms rotate`, the room's open connections close; read the token again from `rooms.json` and reconnect.

## Internals

- The room can write anything in its profile, so rooms never writes or deletes through what it finds there. Its own files live in `control/<name>/`, mounted read-only in the room. A room started from an image older than that mount ignores its `device` and `flags` settings and is never stopped for being idle, until the image is rebuilt and the room restarted.
- The viewer binds 127.0.0.1 on an ephemeral port and answers only requests whose Host is `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding); POSTs also need a same-origin `Origin`.
- `rooms autostart` installs a LaunchAgent that runs `rooms watch <name> --start`: it starts the room at login unless it was stopped on purpose, and restarts it after three failed heartbeats while its container runs. A restart that fails is retried (1 minute, doubling to 30) from `control/<name>/restart.json` until it works or someone runs `down`. A container that isn't running otherwise is left down.
- Each watcher also calls `update`, which builds the image at most once a day under `run/update.lock` (state in `run/update.json`) and promotes the build when its Chromium is newer or the image's files changed. Heartbeat moves a room to a promoted build once it has been unused for an hour with no lease held, behind a `pre-update-*` checkpoint, and rolls back to it and `:previous` if the room doesn't start or loses a sign-in (`control/<name>/update.json` then skips that build).
