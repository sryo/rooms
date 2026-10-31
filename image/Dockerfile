# rooms-chrome: just enough Linux to run one Chromium for a room.
# Build:  container build -t rooms-chrome:latest -f image/Dockerfile .
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium xvfb nodejs dumb-init ca-certificates \
      fonts-inter fonts-noto-core fonts-noto-color-emoji fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 room \
 && mkdir -p /profile /opt/rooms && chown room:room /profile

COPY relay.mjs /opt/rooms/relay.mjs
COPY image/entrypoint.sh /opt/rooms/entrypoint.sh
COPY image/policies.json /etc/chromium/policies/managed/rooms.json

USER room
ENV DISPLAY=:99 ROOMS_CDP_PORT=9222 ROOMS_RELAY_PORT=9223
EXPOSE 9223
ENTRYPOINT ["dumb-init", "--", "/bin/sh", "/opt/rooms/entrypoint.sh"]
