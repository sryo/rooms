# rooms

rooms gives your AI agents their own browsers to work in, so they stop borrowing yours. A room is one Chromium on your Mac, set up for one job and kept signed in. You sign in to each site once, or copy a few sessions over from Chrome, and from then on your agent opens tabs, clicks and types there.

A room runs out of sight and keeps working while your Mac is locked. It never moves your mouse or takes over your windows, and you can watch it and take over whenever you want. Nothing goes to the cloud.

rooms is made for [perch](https://github.com/sryo/perch), which lets your agents use a browser.

## Install

```bash
brew install container && container system start
git clone https://github.com/sryo/rooms && cd rooms
container build -t rooms-chrome:latest -f image/Dockerfile .
container builder stop
npm link
```

## Use

```bash
rooms init work                              # create the room
rooms up work                                # start it
rooms site add work https://github.com       # a site to stay signed in to
rooms signin work https://github.com         # watch, take over, sign in once (Ctrl-C to close)
rooms check work                             # which sites are still signed in, and until when
rooms status                                 # every room, and since when the up ones started
rooms down work                              # stop it
```

A running room holds on to the memory it has used, so stop the ones you aren't using. Their sign-ins are kept for next time. `rooms set work idle=30m` stops a room nothing has used for that long, while `autostart` keeps it watched; stopping closes its tabs, so leave it off for a room where you review what an agent left open.

Keep it to two or three rooms, one per kind of job (say `jobs`, `figma` and `general`), and seed each from Chrome, so you sign in as little as possible. Start and stop a new room once, add its sites, then:

```bash
rooms signin work --from chrome github.com linear.app
```

That copies those sites' cookies (only cookies: passwords and other site data stay in Chrome), starts the room, checks its sites and names any that still need `rooms signin work <url>`. `--from` also takes `canary` or an absolute Chrome profile path. macOS asks to let rooms read Chrome's key; allow it.

Set a room up while it's down, and before signing in, since a new user agent can sign sites out:
- `rooms set work memory=6G` gives a heavy room more memory (3G by default).
- `rooms set mobile device=phone` makes a room look like a phone; `device=desktop` undoes it. `rooms flags set` takes your own user agent, touch, scale and window size flags instead.

Also:
- `rooms status work --deep` runs a room's checks and says how to fix each one that fails.
- `rooms logs work` shows what happened to a room: up, down, crashes, idle stops, checks, imports and sign-in handoffs. `--follow --until handoff.ended` waits for the next one, which is how an agent waits for you to finish signing in.
- `rooms rotate work` gives a room a new token without restarting it, so nothing signs out.
- `rooms autostart work on` starts a room at every login and restarts it if it crashes; a room you `rooms down` stays down. `off` undoes it.
- `rooms snapshot save work <name>` snapshots a stopped room's profile. `rooms snapshot restore work <name>` brings it back after damage and keeps the profile it replaces; `snapshot list` shows both, and `snapshot delete` removes one.
- Output is for people in a terminal, and JSON when piped or with `--json`.
- `rooms` on its own lists every command. Older names (`list`, `doctor`, `teleport`, `checkpoint`, `restore`, `prune`, `view --signin`) still work.

## With perch

`list_tabs {app:"room"}` lists the tabs in your rooms and `new_tab {app:"room:work"}` opens one, in its own window so it keeps drawing. Every other tool takes that tab as `target: {tabId}`; without a target, perch drives your own browser, not the room. Anything else that speaks CDP connects through `rooms endpoint work --ws`.

While you watch a room in `rooms view` or `rooms signin`, you hold the tab it shows, and agents get `tab_held` until you close it (for `signin`, until the site is signed in).

Tools can read `~/.rooms` directly, and `test/contract.test.mjs` and `test/leases.test.mjs` pin what they may rely on:
- `rooms.json`: `version` 1, and `rooms.<name>` with `cdp.host`, `cdp.port` and `cdp.token` (the relay takes the token as the first path segment or as a Bearer header) and `sites[]` with `origin`, `url` and `signedOut`, a path pattern for a signed-out page.
- `downloads/<name>/` is the room's `/downloads`.
- `run/leases/<sha256 of the tabId>.json` is a tab's lease, in perch's format: `{owner, pid, last, active, held}`, changed only while holding the folder `<that file>.lock` (taken over after five seconds). A lease holds its tab while its process lives and it is `active` or `last` is under five seconds old. The viewer's lease has `owner: "user"`.
- `control/<name>/` is rooms' own: `token`, `events.jsonl` (one `{at, event, …}` per line, capped, the older half in `events.jsonl.1`), `owner.json` (who started the room, and when) and `watcher.json`.
- `GET <port>/health` needs no token and answers `{ok, protocol}`. `GET <endpoint>/rooms/activity` answers `{idleMs}`, the time since a client last used the room.
- After `rooms rotate`, the room's open connections close; read the token again from `rooms.json` and reconnect.

## Safety

Only your Mac can reach a room. Anything you connect to it can use all its sign-ins, so connect only agents you trust with those accounts, and give separate jobs separate rooms. rooms never stores your passwords. `rooms init` keeps `~/.rooms` out of Time Machine, so its sessions don't end up on your backup disk.

The room can write anything in its profile, so rooms never writes or deletes through what it finds there. Its own files live in `control/<name>/`, which the room can only read. This needs the image rebuilt (`container build`, as in Install) and the room restarted; until then the room ignores its device and flags settings and is never stopped for being idle.
