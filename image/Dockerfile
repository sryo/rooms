# rooms-chrome: just enough Linux to run one Chromium for a room.
# Build:  container build --no-cache -t rooms-chrome:latest -f image/Dockerfile .
FROM debian:trixie-slim

# Chromium's SwiftShader carries its own LLVM, so Mesa's drivers and the LLVM and z3 they link are
# never loaded. Their files go in the layer that installs them (a later layer would only hide them);
# the packages stay registered, because chromium and xvfb depend on them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium xvfb nodejs dumb-init ca-certificates \
      fonts-inter fonts-noto-core fonts-noto-color-emoji fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && dpkg -L libllvm19 mesa-libgallium libgl1-mesa-dri libz3-4 \
    | while read -r f; do if [ -f "$f" ] || [ -L "$f" ]; then rm -f "$f"; fi; done \
 && useradd --create-home --uid 1000 room \
 && mkdir -p /profile /opt/rooms && chown room:room /profile

COPY relay.mjs /opt/rooms/relay.mjs
COPY image/entrypoint.sh /opt/rooms/entrypoint.sh
COPY image/policies.json /etc/chromium/policies/managed/rooms.json

USER room
ENV DISPLAY=:99 ROOMS_CDP_PORT=9222 ROOMS_RELAY_PORT=9223
EXPOSE 9223
ENTRYPOINT ["dumb-init", "--", "/bin/sh", "/opt/rooms/entrypoint.sh"]
