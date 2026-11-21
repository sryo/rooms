<img src="logo.svg" alt="rooms" width="128">

# rooms

rooms gives your AI agents their own browsers to work in, so they stop borrowing yours. A room is one Chromium on your Mac, set up for one job and kept signed in. You sign in to each site once, or copy a few sessions over from Chrome, and from then on your agent opens tabs, clicks and types there. A room runs out of sight and keeps working while your Mac is locked. It never moves your mouse or takes over your windows, and you can watch it and take over whenever you want. Nothing goes to the cloud.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/sryo/rooms/main/install.sh | bash
```

It installs Apple's `container` with Homebrew if it's missing, and builds the room's browser. Run it again to update. [docs/guide.md](docs/guide.md) has where it goes and how to install by hand.

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

Seed a room's sign-ins from Chrome instead of signing in again: `rooms signin work --from chrome github.com linear.app`. Your agents drive rooms through [perch](https://github.com/sryo/perch). `rooms` on its own lists every command, and [docs/guide.md](docs/guide.md) covers settings, autostart and snapshots.

## Safety

Each room runs in its own small Linux machine on your Mac. It sees its own profile and its own downloads folder, and none of your other files. Only your Mac can reach a room. Anything you connect to a room can use all its sign-ins, so connect only agents you trust with those accounts, and give separate jobs separate rooms. rooms never stores your passwords, and keeps its sign-ins out of Time Machine.

## Works with
- [perch](https://github.com/sryo/perch): how your agents drive a room, and your own browser too.
- [loft](https://github.com/sryo/loft): a hidden screen, for when the agent needs your own browser profile out of your way rather than a room.
