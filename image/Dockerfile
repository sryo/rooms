# rooms-chrome: just enough Linux to run one Chromium for a room.
# Build:  container build --no-cache -t rooms-chrome:latest -f image/Dockerfile .; container builder stop
FROM debian:trixie-slim

# Chromium's SwiftShader carries its own LLVM, so Mesa's drivers and the LLVM and z3 they link are
# never loaded. Nor are systemd (GTK pulls it in through D-Bus), the Vulkan validation layer, gconv,
# GTK's icons and emoji data, docs, Node's corepack and types, or the Noto fonts for historic scripts.
# Their files go in the layer that installs them (a later layer would only hide them); the packages
# stay registered, because chromium and xvfb depend on them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium xvfb nodejs dumb-init ca-certificates \
      fonts-inter fonts-noto-core fonts-noto-color-emoji fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && dpkg -L libllvm19 mesa-libgallium libgl1-mesa-dri libz3-4 systemd libsystemd-shared \
    | while read -r f; do if [ -f "$f" ] || [ -L "$f" ]; then rm -f "$f"; fi; done \
 && rm -rf /usr/lib/chromium/libVkLayer_khronos_validation.so* /usr/lib/chromium/libVkICD_mock_icd.so* \
      /usr/lib/aarch64-linux-gnu/gconv /usr/share/doc /usr/share/man /usr/share/gtk-3.0/emoji \
      /usr/share/nodejs/corepack /usr/share/nodejs/@types \
      /usr/share/fonts/truetype/noto/Noto*SignWriting* /usr/share/fonts/truetype/noto/Noto*Tangut* \
      /usr/share/fonts/truetype/noto/Noto*Cuneiform* /usr/share/fonts/truetype/noto/Noto*EgyptianHieroglyphs* \
      /usr/share/fonts/truetype/noto/Noto*Linear[AB]* /usr/share/fonts/truetype/noto/Noto*ImperialAramaic* \
      /usr/share/fonts/truetype/noto/Noto*Nushu* /usr/share/fonts/truetype/noto/NotoSansOld* \
 && find /usr/share/icons/Adwaita /usr/share/icons/hicolor -mindepth 1 ! -name index.theme -delete \
 && fc-cache -f \
 && useradd --create-home --uid 1000 room \
 && mkdir -p /profile /opt/rooms && chown room:room /profile

COPY relay.mjs /opt/rooms/relay.mjs
COPY image/entrypoint.sh /opt/rooms/entrypoint.sh
COPY image/policies.json /etc/chromium/policies/managed/rooms.json

USER room
ENV DISPLAY=:99 ROOMS_CDP_PORT=9222 ROOMS_RELAY_PORT=9223
EXPOSE 9223
ENTRYPOINT ["dumb-init", "--", "/bin/sh", "/opt/rooms/entrypoint.sh"]
