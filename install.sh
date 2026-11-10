#!/usr/bin/env bash
# rooms installer — installs Apple's container runtime if missing, clones rooms, builds the room
# image and puts `rooms` on PATH with npm link.
# Re-runnable: pulls instead of cloning, and skips the image build when the image already exists.
#
# Overrides:
#   ROOMS_REPO=...     git URL to clone from
#   ROOMS_DIR=...      install location (default: ~/.rooms/src; ~/.rooms itself holds the rooms' data)
#   ROOMS_REBUILD=1    rebuild the image even when rooms-chrome:latest exists

set -euo pipefail

ROOMS_REPO="${ROOMS_REPO:-https://github.com/sryo/rooms.git}"
ROOMS_DIR="${ROOMS_DIR:-$HOME/.rooms/src}"
ROOMS_REBUILD="${ROOMS_REBUILD:-0}"
IMAGE="rooms-chrome:latest"

[[ "$(uname -s)" == "Darwin" ]] || { echo "rooms only works on macOS." >&2; exit 1; }

command -v git >/dev/null || { echo "git not found. Run: xcode-select --install" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found. Install Node 22.16+ from https://nodejs.org (or: brew install node)" >&2; exit 1; }
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 16) ? 0 : 1)' \
  || { echo "node $(node -v) < 22.16. Upgrade Node (brew upgrade node)." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm not found. Reinstall Node from https://nodejs.org (or: brew install node)" >&2; exit 1; }
if ! command -v container >/dev/null; then
  if command -v brew >/dev/null; then
    echo "Installing Apple's container runtime..."
    brew install container
  else
    echo "container not found. Install it from https://github.com/apple/container/releases (or install Homebrew, then: brew install container)" >&2
    exit 1
  fi
fi

if [[ -f "$ROOMS_DIR/rooms.mjs" ]]; then
  if [[ -d "$ROOMS_DIR/.git" ]]; then
    echo "rooms already at $ROOMS_DIR — pulling latest..."
    git -C "$ROOMS_DIR" pull --ff-only
  else
    echo "rooms already at $ROOMS_DIR (local, no git repo — skipping pull)..."
  fi
else
  echo "Cloning rooms to $ROOMS_DIR..."
  mkdir -p "$(dirname "$ROOMS_DIR")"
  git clone "$ROOMS_REPO" "$ROOMS_DIR"
fi

echo "Starting container..."
container system start

if [[ "$ROOMS_REBUILD" != "1" ]] && container image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "$IMAGE already built — skipping (ROOMS_REBUILD=1 rebuilds it)."
else
  echo "Building $IMAGE (a few minutes)..."
  # The builder is a VM holding 2 GB while it runs, so it stops even when the build fails.
  build=0
  (cd "$ROOMS_DIR" && container build --no-cache -t "$IMAGE" -f image/Dockerfile .) || build=$?
  container builder stop || true
  [[ "$build" == "0" ]] || { echo "Image build failed. Re-run with: ROOMS_REBUILD=1 bash $ROOMS_DIR/install.sh" >&2; exit "$build"; }
fi

echo "Linking the rooms CLI..."
(cd "$ROOMS_DIR" && npm link)

cat <<EOF

rooms installed at $ROOMS_DIR

Next, make a room and sign in to a site in it:

  rooms init <name>              # e.g. rooms init work
  rooms up <name>                # start it
  rooms site add <name> <url>    # a site to stay signed in to
  rooms signin <name> <url>      # watch, take over, sign in once (Ctrl-C to close)

\`rooms\` on its own lists every command. Your agents drive rooms through
perch: https://github.com/sryo/perch
EOF
