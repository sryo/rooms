# rooms

A signed-in browser for your agents, on your own Mac.

A room is one Chromium in a small Linux VM, with a profile that's never recreated. You sign in to each site once, inside the room, and your agents use it from then on. They never touch your screen, and they keep working while your Mac is locked. You can watch a room and take over at any time.

## Install

```bash
brew install container && container system start
git clone https://github.com/sryo/rooms && cd rooms
container build -t rooms-chrome:latest -f image/Dockerfile .
npm link
```

Needs macOS 26+ and Apple silicon.

## Use

```bash
rooms init work                              # create the room
rooms up work                                # start it
rooms site add work https://github.com       # a site to stay signed in to
rooms view work --signin https://github.com  # watch, take over, sign in once
rooms check work                             # which sites are still signed in
rooms status | down work
```

To copy selected sessions from Chrome after the room has been started and stopped once:

```bash
rooms down work
rooms teleport work --from canary --sites github.com,linear.app
rooms up work
rooms site add work https://github.com
rooms check work
```

`--from` accepts `canary`, `chrome`, or an absolute Chrome profile path. Teleport reads a consistent snapshot of the source Cookies database, asks Keychain for that browser's Safe Storage secret, and copies only cookies for the named domains and their subdomains. It re-encrypts them for the room and leaves unrelated room cookies in place. The room must be down. A copied session may still require a fresh sign-in if the site binds it to the original device.

For a profile checkpoint, shut the room down so Chromium flushes its data, then snapshot it:

```bash
rooms down work
rooms checkpoint work before-update
rooms checkpoints work
rooms up work
```

Use `rooms restore work before-update` only to recover a damaged profile, with the room down. Restore preserves the replaced profile under `~/.rooms/replaced/work/`. `rooms prune work before-update` removes that checkpoint. Checkpoints request APFS copy-on-write clones and fall back to regular copies when cloning is unavailable. Before starting a room, `up` compares the profile's `Last Version` with the image's Chromium version and refuses a downgrade that could damage the profile.

`rooms doctor work` checks the profile, container and CDP endpoint and returns a typed state. `rooms watch work` probes CDP every 30 seconds and restarts the same profile after three consecutive failures; a deliberate `rooms down` stays down. `rooms autostart work` writes a LaunchAgent that starts the monitor at the next login and brings up a room that was not deliberately stopped. `rooms autostart work --remove` removes that login agent.

Set Chromium flags while a room is down, preferably before signing in. For a mobile site: `rooms flags set mobile '--user-agent=Mozilla/5.0 (Linux; Android 14) Mobile' --touch-events=enabled`, then `rooms up mobile`. `rooms flags list mobile` shows the saved flags. The allowlist covers user agent, touch events, device scale and window size; each flag is passed as one argument, including spaces in a user agent.

The image disables Chromium's password-saving prompt and first-run promotions through managed policy. Shared memory is half the configured room RAM, capped at 2 GiB. The image still launches with `--no-sandbox` while its sandbox behavior in the container VM is being verified.

## For agents

[perch](https://github.com/sryo/perch) drives a room's tabs as `room:<name>:<targetId>`: `list_tabs {app:"room"}` lists them, `new_tab {app:"room:work"}` opens one, and any tool then takes that `target.tabId`.

Anything else that speaks CDP connects through `rooms endpoint work --ws`. For figma-cdp: `FIGMA_BACKEND=cdp FIGMA_CDP_PORT="$(rooms endpoint work --ws)"`.

## Safety

A room is reachable only from your Mac, and only with its token. Perch agents can drive pages but can't read the room's cookies. The `rooms teleport` CLI explicitly reads selected source cookies when you run it. The sign-in sheet types your password into the room only while the tab is on the site you named, and never stores or logs it.
