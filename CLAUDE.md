# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

StarPi rocket ground station: a Python backend that receives telemetry from the
rocket (BLE today, LoRa planned), stores it in SQLite and streams it, plus an
Open MCT frontend served by Apache. Runs on a Raspberry Pi 4 via Docker Compose.
README.md and backend/README.md are detailed and current — read them for API,
settings and how the flight state is used.

## Commands

Top-level `Makefile` wraps `docker compose` (compose file is the source of truth):

- `make up` — set up host Bluetooth, build, start, wait for backend healthcheck (UI at http://localhost:8040, login `testuser` / `NasaIsCool!`)
- `make sim` — same stack fed by the built-in telemetry simulator (`SP_LINKS=sim`, separate `simulator.db`). Use this for any work without a rocket.
- `make down`, `make logs [S=backend]`, `make ps`, `make build`
- `make test` — frontend flight-tracking tests: `node --test openmct/flight/flight-state.test.js`. Filter a single test with `node --test --test-name-pattern='<regex>' openmct/flight/flight-state.test.js`.
- `make deploy PI=starpi@starpi.local` / `make bundle` / `make load` — cross-build arm64 images under QEMU for an offline Pi; then `make up BUILD=--no-build` on the Pi.

Backend alone (`backend/Makefile`): `make build`, `make run`, `make run-sim` (no BLE needed, serves bundled web dashboard), `make dev` (runs `python src/main.py` on the host; needs `pip install -r requirements.txt`). API reference at http://localhost:8000/docs.

There are no backend tests and no linter configured.

## Architecture

```
Rocket --BLE--> Link --> Station.on_frame --> protocol.decode --> SQLite (db.py)
                                                              \--> Hub --> /ws websocket clients
Browser --POST /api/commands--> Station --> Link --> rocket
Apache :8040 (basic auth) serves openmct/ and proxies /api, /ws, /docs to backend:8000
```

### Backend (`backend/src/`, FastAPI + uvicorn, async)

- `station.py` owns everything: links, DB, hub, decode/store error counters, command dispatch.
- `links/` is a transport abstraction (`base.Link`). Nothing above this layer may assume BLE; a link only moves bytes, decoding lives in `protocol.py`. New transports register via `links.create_link` and are enabled by name in `SP_LINKS`. `LinkError` subclasses (`UnknownCommand`, `UnknownLink`, `BadCommand`) map to 4xx; plain `LinkError` maps to 503 — catch subclasses first.
- `protocol.py` mirrors the firmware header `spec/logger.h` (and `links/ble.py` mirrors `spec/Ble.hpp`). Frame: 8 B timestamp + 2 B flags + payload, little-endian. Flags pack enum **indices**, while the Python enum values are `1 << index` bit flags used for mask-based query filters — don't conflate the two. Changes to the wire format must start from the `spec/` headers.
- `links/sim.py` flies a full scripted flight every 250 s so every flight phase shows in the frontend, at `SP_SIM_RATE` pkt/s (350 by default, above the real rocket's ~300; the per-type mix is `RATES_HZ`). `make sim SP_SIM_RATE=500` changes it. Its timestamps count from link start (an MCU clock GPS has not set).
- Timestamps are the rocket MCU's, which only knows the date once GPS sets it (maybe never): never compare them to the ground's wall clock. Each backend start writes a new DB file named after `SP_DB_PATH` (`db.run_path`, `starpi-0001-<utc>.db`) so runs never mix; `Station.run` names it (in `/api/health` and the ws `hello`), and `rocket_time` in `/api/health` is the MCU clock as last heard.
- Ingest publishes before it stores: `Station.on_frame` decodes, assigns the packet id (continuing the table's AUTOINCREMENT sequence) and broadcasts; one writer task then stores the queued packets in a single transaction at most every `WRITE_INTERVAL_S` (`db.insert_packets`). The live stream must never wait on the Pi's SD card. `db.py` writes on one connection and reads on a pool of `READERS` connections; run PRAGMAs through `_pragma()`, since an unread result pins a read snapshot and stops the WAL from ever being rewound.
- All config is env vars (`config.py`, `SP_*`).

### Frontend (`openmct/`)

- No bundler: plain browser scripts loaded in order by `index.html`, each an IIFE exposing a global (`window.StarPiPlugin`, `window.StarPi`, `window.StarPiFlightService`, ...). `starpi-app.js` configures Open MCT and installs the plugins. `flight/flight-state.js` is UMD so Node tests can `require` it.
- **Adding a new file requires adding it to both `openmct/index.html` and an explicit `COPY` line in `apache/Dockerfile`**, or it won't be in the image.
- Open MCT and three.js come from npm (`openmct/package.json`, versions pinned) and are copied into the Apache image; three.js is loaded via dynamic `import()` in `rocket/rocket-view.js`.
- `starpi-plugin.js` builds the telemetry tree following Open MCT conventions: one telemetry object per measured quantity, one range per object, grouped by subsystem. The StarPi root holds only dashboards (Launch Control, the default page); quantities go under `Telemetry/`, embeddable views under `Widgets/`. Folders are `FOLDERS`; moving an object keeps its identifier, so saved layouts still resolve. History from `GET /api/packets`, realtime from `/ws`, link state from `/api/health`.
- The flight phase is reported by the rocket (`T_ROCKET_STATE`, `RocketState` in `spec/logger.h`; it also says which parachutes are out). `flight/flight-state.js` derives launch time, apogee, ground level and pad position client-side from it and the sensors; `flight-service.js` feeds it from telemetry and exposes the results as telemetry objects.
- `brand/` is the team look, reused by every view: `brand.css` is the only place colours are defined (patch palette + per-theme roles `--sp-bg/ink/accent/data/ok/warn/alarm`); views alias those tokens instead of writing colours. `brand.js` (`window.StarPiBrand`) exposes `color()`, `cssVar()`, `lockup()` and the Open MCT branding plugin. `openmct-accent.css` is generated by `scripts/openmct-accent.py` (rerun after an Open MCT upgrade). Wordmarks are Nasalization outlines from `scripts/brand-assets.py`: never ship the font itself (licence forbids web fonts).
- `dashboard/seed.js` creates the standard "StarPi Flight Dashboard" in *My Items* from stock Open MCT objects. Persistence is browser localStorage only (no CouchDB), so seeded objects persist per-browser; changes to seed output only appear after deleting that folder and reloading.
- `launch-control/basemap.js` draws an offline map (MapLibre + a Protomaps `.pmtiles` extract, or satellite raster tiles) under the Position-from-pad canvas, following its centre and scale. `make tiles LAT= LON=` (`scripts/fetch-tiles.py`) writes `openmct/tiles/` (gitignored), which the Apache image copies in; no `site.json` means no toggle.
- `launch-control/` is a custom fixed-layout dashboard; `commands/` is the command panel (two-click confirm, disabled when link is down); `rocket/` is the 3D attitude view (IMU Z = rocket long axis, `EULER_ORDER` constant).
- The Realtime conductor runs on `RocketClock` (`starpi-plugin.js`, `window.StarPi.clock`), not the local clock: the newest MCU timestamp, extrapolated between packets. Use `openmct.time.now()` / `StarPi.clock.currentValue()` for "now" against telemetry time, never `Date.now()` (fine only for local receive times like staleness and packet rate). The page reloads when the backend's `run` changes.
- Realtime conductor window ends 5 s in the future (`LEAD` in `starpi-app.js`) and values go stale after 5 s without their message type — intentional, see comments there.

## Host setup

`scripts/setup-bluetooth.sh` (run by `make up`) powers the host BlueZ controller; the backend container talks to it over the host D-Bus socket. `scripts/setup-hotspot.sh` (`make hotspot PASSWORD=...`) configures a NetworkManager Wi-Fi hotspot on the Pi. `scripts/setup-lan.sh` (`make lan`) makes the Pi serve DHCP on its Ethernet port (10.43.0.1) for a laptop on a direct cable.
