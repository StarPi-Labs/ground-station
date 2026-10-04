# radio_app, the firmware repo's LoRa ground receiver (mcu: app/raspberry),
# which drives the radio for the backend's LoRa link. Its source is not in
# this repository: it comes from the `src` build context declared in
# docker-compose.yml (RADIO_APP_SRC).
FROM debian:trixie-slim AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates cmake g++ git make \
    && rm -rf /var/lib/apt/lists/*
COPY --from=src CMakeLists.txt /src/CMakeLists.txt
COPY --from=src src /src/src
# Fetches RadioLib, half, nlohmann/json and lgpio, and builds them.
RUN cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /build -j"$(nproc)" \
    && mkdir /out \
    && cp /build/radio_app /out/ \
    && find /build /usr/lib -name 'liblgpio.so*' -exec cp -a {} /out/ \;

FROM debian:trixie-slim
COPY --from=build /out/radio_app /usr/local/bin/radio_app
COPY --from=build /out/liblgpio.so* /usr/local/lib/
RUN ldconfig
# lgpio keeps its notification pipes in the working directory.
WORKDIR /tmp
# The sockets go in the directory shared with the backend.
ENTRYPOINT ["radio_app", "/run/starpi"]
