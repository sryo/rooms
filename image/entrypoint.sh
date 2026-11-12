#!/bin/sh
# One room: Xvfb, one Chromium on the mounted /profile with DevTools on guest loopback only,
# and the token relay (the only thing the published port reaches). Chromium is restarted if it
# exits; the profile is never replaced.
set -eu

# The token: /rooms/token, which the host can rewrite to rotate it, or ROOMS_TOKEN from an older host.
if [ -s /rooms/token ]; then export ROOMS_TOKEN_FILE=/rooms/token
else [ -n "${ROOMS_TOKEN:-}" ] || { echo "rooms: ROOMS_TOKEN missing; refusing to start" >&2; exit 64; }; fi
[ -d /profile ] || { echo "rooms: /profile not mounted; refusing to start (a fresh profile is signed out)" >&2; exit 65; }

# A container that was killed leaves Chromium's singleton files naming the old hostname, which
# makes the next Chromium refuse the profile. Only one Chromium runs per room, so they are stale.
rm -f /profile/SingletonLock /profile/SingletonSocket /profile/SingletonCookie
# The caches go on the container's own disk (--disk-cache-dir below), not in the profile on the Mac,
# and a new container starts without them. Profiles from before that still hold theirs: cleared
# here, in the guest, because the host must not delete inside a folder the guest controls.
rm -rf "/profile/Default/Code Cache" "/profile/Default/Cache"

# The room's size (rooms writes it at each start): the screen and the window both take it.
size=$(cat /rooms/size 2>/dev/null || true)
case "$size" in [0-9]*x[0-9]*) ;; *) size=1440x900 ;; esac

# Xvfb and the relay are restarted if they die: without either the room answers
# nothing until someone runs down and up.
( while :; do Xvfb :99 -screen 0 "${size}x24" -nolisten tcp -ac; echo "rooms: Xvfb exited; restarting" >&2; sleep 1; done ) &
( while :; do node /opt/rooms/relay.mjs; echo "rooms: relay exited; restarting" >&2; sleep 1; done ) &

# On stop, end Chromium cleanly (it flushes cookies on SIGTERM) and don't restart it.
stopping=0
trap 'stopping=1; [ -n "${chrome:-}" ] && kill -TERM "$chrome" 2>/dev/null; wait "${chrome:-}" 2>/dev/null; exit 0' TERM INT

while [ "$stopping" = 0 ]; do
  set -- \
    --user-data-dir=/profile \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="${ROOMS_CDP_PORT}" \
    --remote-allow-origins="http://127.0.0.1:${ROOMS_CDP_PORT}" \
    --no-first-run --no-default-browser-check \
    --password-store=basic \
    --use-angle=swiftshader-webgl --enable-unsafe-swiftshader \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --disable-features=BackForwardCache,Translate,OptimizationHints,MediaRouter \
    --disable-component-extensions-with-background-pages \
    --disk-cache-size=67108864 \
    --disk-cache-dir=/tmp/rooms-cache \
    --window-size="${size%x*},${size#*x}" \
    --hide-crash-restore-bubble
  # The Mac's appearance when the room started (rooms writes it): pages see prefers-color-scheme.
  if [ "$(cat /rooms/appearance 2>/dev/null)" = dark ]; then set -- "$@" --force-dark-mode; fi
  if [ -f /rooms/flags ]; then
    while IFS= read -r flag; do [ -n "$flag" ] && set -- "$@" "$flag"; done < /rooms/flags
  fi
  # The RestoreOnStartup policy reopens the last session, after a crash too; a URL here would add a tab each time.
  chromium "$@" &
  chrome=$!
  rc=0
  wait "$chrome" || rc=$?
  [ "$stopping" = 0 ] || break
  # `rooms down` writes this before Browser.close. A nonzero exit during shutdown
  # must not race the host's container stop and restart Chromium on the profile.
  if [ -e /rooms/stop ]; then echo "rooms: stop requested; waiting for container stop" >&2; while [ "$stopping" = 0 ]; do sleep 1; done; break; fi
  # A clean exit is Browser.close from `rooms down`, which stops the container
  # next: relaunching would start Chromium on the profile mid-stop.
  if [ "$rc" = 0 ]; then echo "rooms: chromium closed; waiting for stop" >&2; while [ "$stopping" = 0 ]; do sleep 1; done; break; fi
  echo "rooms: chromium exited ($rc); restarting in 2 s" >&2
  sleep 2
done
