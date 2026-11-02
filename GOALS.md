# rooms: goals

## What rooms is for
People who hand their agents browser work on their own Mac, and want those agents out of their browser. A room is one Chromium per job, kept signed in, that agents drive over CDP (through [perch](https://github.com/sryo/perch)) while the user keeps working, and that keeps going while the Mac is locked.

It has to beat the two things people do instead: lending the agent your own browser, which takes your screen and your sessions, and a cloud browser, which puts your sign-ins on someone else's machine and still has to be signed in again.

## Never traded
- Nothing a room does touches the user's screen, windows, input or own browser.
- Sign-ins stay on this Mac. A room is reachable only on loopback and only with its token, rooms never stores a password, and profiles stay out of Time Machine.
- rooms never loses a profile. It never writes or deletes through what the room can change, and it never starts Chromium on a profile it could wipe (an older major version).

## Goals, in priority order
When two goals conflict, the higher one wins.

1. **Stays signed in.** A site signed in once stays signed in across downs, crashes, restarts and image updates, until the site itself ends the session.
2. **Never pulls the rug from an agent.** Nothing stops, restarts or moves a room while a tab is held or anything has used it recently.
3. **Looks after itself.** Without anyone running anything, a room comes back after a crash, keeps its tabs, and moves to each new Chromium within days of Debian shipping it. It speaks up only when it can't, once.
4. **Light on the Mac.** A room's VM keeps all the memory it ever touches, so rooms are sized small and stopped when idle, and caches stay off the profile.
5. **Quick to start.** `rooms up` answers CDP in a few seconds.

## How we know
| Goal | Metric | Where | Run |
|---|---|---|---|
| 1 | sites signed in after down/up, crash and update; update rollback on a lost sign-in | `rooms check <name>`, `test/update.test.mjs`, `test/sites.test.mjs` (down flushes cookies), `test/rooms.test.mjs` (profile_newer) | `npm test` |
| 2 | no stop or move while a lease is held or the room was used in the last hour | `test/update.test.mjs`, `test/rooms.test.mjs` (idle stop and held tabs), `test/leases.test.mjs` | `npm test` |
| 3 | days the image is behind; restart and update failures | `rooms status <name> --deep` (image, container), `test/update.test.mjs`, `test/rooms.test.mjs` | live: `node rooms.mjs status main --deep` |
| 4 | room memory against the 80% cap | `test/rooms.test.mjs` (the 80% check) | `npm test` |
| 4 | profile size, KB | `du -sk ~/.rooms/profiles/<name>` | live: `du -sk ~/.rooms/profiles/main` |
| 4 | container exec calls per `rooms up`, CDP calls per `rooms check` of three sites, lines of code | `bench/run.mjs` (the test fakes, no container or browser) | `node bench/run.mjs` |
| 5 | median ms from `rooms up` to CDP, over the last 10 ups | `rooms logs <name> --up-ms` (each `up` event logs `ms`) | live: `node rooms.mjs logs main --up-ms \| python3 -c "import json,sys; print(json.load(sys.stdin)['medianMs'])"` |

Caps: `q3 k2 n2 b2 t1` (how firm each kind of number is: 3 hard, must end the same or better; 2 semi-hard, past its margin you choose; 1 semi-hard with a 10% margin; 0 soft, no limit; fium RULES.md K6)

## Non-goals
- Running anywhere but this Mac: no hosted rooms, no sharing a room between machines.
- Fresh throwaway browsers per test run. That's Playwright's job; a room is one long-lived profile.
- A password manager. Sign-ins are sessions, made by the user once.
- Getting past bot detection. A room is a real, headful Chromium so sites behave as they do for the user, not to look like someone else.
- Browsers other than Chromium, or hosts other than Apple's `container`.
