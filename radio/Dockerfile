# radio_app, the LoRa ground receiver, which drives the radio for the
# backend's LoRa link.
FROM debian:trixie-slim AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates cmake g++ git make \
    && rm -rf /var/lib/apt/lists/*
COPY CMakeLists.txt /src/CMakeLists.txt
COPY src /src/src
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
