# Using rooms

More than the README covers. `rooms` on its own lists every command.

## How many rooms

A running room holds on to the memory it has used, so stop the ones you aren't using. Their sign-ins are kept for next time.

Keep it to two or three rooms, one per kind of job (say `jobs`, `figma` and `general`), and seed each from Chrome, so you sign in as little as possible. Start and stop a new room once, add its sites, then:

```bash
rooms signin work --from chrome github.com linear.app
```

That copies those sites' cookies (only cookies: passwords and other site data stay in Chrome), starts the room, checks its sites and names any that still need `rooms signin work <url>`. `--from` also takes `canary` or an absolute Chrome profile path. macOS asks to let rooms read Chrome's key; allow it.

## Settings

Set a room up while it's down, and before signing in, since a new user agent can sign sites out:
- `rooms set work memory=6G` gives a heavy room more memory (3G by default).
- `rooms set mobile device=phone` makes a room look like a phone; `device=desktop` undoes it. `rooms flags set` takes your own user agent, touch, scale and window size flags instead.
- `rooms set work idle=30m` stops a room nobody has used for that long, while `autostart` is on. Stopping closes its tabs, so leave it off for a room where you review what an agent left open.

## Also

- `rooms status work --deep` runs a room's checks and says how to fix each one that fails, including when the room needs a rebuilt image after you update rooms.
- `rooms logs work` shows what happened to a room: up, down, crashes, idle stops, checks, imports and sign-in handoffs. `--follow --until handoff.ended` waits for the next one, which is how an agent waits for you to finish signing in.
- `rooms rotate work` gives a room a new token without restarting it, so nothing signs out.
- `rooms autostart work on` starts a room at every login, and restarts it when its browser stops answering. A room that stops, or that you `rooms down`, stays down. `off` undoes it. It also keeps the room patched: once a day it builds the image again, and when Chromium is newer the room moves to it the next time nothing has used it for an hour, behind a snapshot it goes back to if a site signs out. `rooms update` builds now.
- `rooms snapshot save work <name>` snapshots a stopped room's profile. `rooms snapshot restore work <name>` brings it back after damage and keeps the profile it replaces; `snapshot list` shows both, and `snapshot delete` removes one.
- Output is for people in a terminal, and JSON when piped or with `--json`.
- Older names (`list`, `doctor`, `teleport`, `checkpoint`, `restore`, `prune`, `view --signin`) still work.

## With perch

`list_tabs {app:"room"}` lists the tabs in your rooms and `new_tab {app:"room:work"}` opens one, in its own window so it keeps drawing. Every other tool takes that tab as `target: {tabId}`; without a target, perch drives your own browser, not the room. Anything else that speaks CDP connects through `rooms endpoint work --ws`.

While you watch a room in `rooms view` or `rooms signin`, you hold the tab it shows, and agents get `tab_held` until you close it (for `signin`, until the site is signed in).

Tools that read rooms' files directly can rely on what [AGENTS.md](../AGENTS.md) lists.
