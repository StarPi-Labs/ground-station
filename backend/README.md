# Backend API

A JSON REST + websocket API for the rocket's MCU. It ingests telemetry frames
over Bluetooth LE and LoRa, stores them in SQLite, pushes every new packet to connected
websocket clients, and forwards commands back to the rocket.

```
rocket ──BLE──────────────────> link ──> decode (logger.h) ──> SQLite ──> GET /api/packets
rocket ──LoRa──> radio_app ──> link ──┘                 └──> websocket /ws
browser ──POST /api/commands──> link ──BLE or radio_app──> rocket
```

Each transport sits behind a `Link` interface (`src/links/`): the API, the
decoder and the storage layer do not know which one a packet came from, other
than by its `link` name.

## Prerequisites

* Docker >= 29.*: for running the backend in a container.
* BlueZ >= 5.55: for Bluetooth communication with the mcu.
* The firmware's `radio_app` (`app/raspberry/` in the `mcu` repo) running on
  the same machine: for the LoRa link only.
* Make: for building/running.

## Getting Started

1. Clone the repository:
    ```sh
    git clone https://github.com/StarPi-Labs/ground-station.git
    cd ground-station/backend
    ```

2. Build:
    ```sh
    make build
    ```

3. Run:
    ```sh
    make run
    ```

Then open <http://localhost:8000/docs> for the generated API reference (`/`
redirects there).

The bundled dashboard is opt-in — set `SP_SERVE_WEB=true` to serve it at `/`:

```sh
make run-web
```

No rocket at hand? `make run-sim` feeds the same pipeline from a built-in
telemetry simulator, dashboard included. It flies a complete flight every 250 s
(20 s on the pad, 3.3 s burn at 8 g, apogee at ~3000 m, drogue descent at
25 m/s, main parachute at 6 m/s below 450 m, landing at T+201 s), so every
flight phase shows up in the frontend. It sends 350 pkt/s by default, above
the real rocket's ~300, for headroom; `SP_SIM_RATE` sets another rate (`make
run-sim SP_SIM_RATE=500`). The rate is shared in a fixed mix: the IMU vectors
at 25% each, altitude and pressure at 10%, temperature and GPS at 2.5% (at
400 pkt/s: 100, 40 and 10 Hz; `RATES_HZ` in `links/sim.py`). On top of that
it reports `T_ROCKET_STATE` on every state change and once a second. Its
timestamps count from the moment it started, like a rocket whose clock GPS
has not set.

To run without Docker:

```sh
pip install -r requirements.txt
python src/main.py
```

## Configuration

All settings come from environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SP_HOST` / `SP_PORT` | `0.0.0.0` / `8000` | HTTP bind address |
| `SP_DB_PATH` | `data/starpi.db` | Names the SQLite files (`/data/starpi.db` in Docker): each start creates a new one, `data/starpi-0001-20261003-142501.db` (run number, UTC start time) |
| `SP_LINKS` | `ble` | Comma-separated links to start: `ble`, `lora`, `sim` |
| `SP_BLE_DEVICE_NAME` | `John StarPi's Rocket` | Device name to scan for |
| `SP_BLE_ADDRESS` | — | Connect to this MAC directly, skipping the name scan |
| `SP_BLE_SCAN_TIMEOUT` | `10` | Scan timeout, seconds |
| `SP_BLE_RECONNECT_DELAY` | `5` | Delay between reconnect attempts, seconds |
| `SP_LORA_TLM_SOCKET` | `/tmp/starpi_tlm.sock` | `radio_app`'s telemetry socket (`/run/starpi/starpi_tlm.sock` under Compose) |
| `SP_LORA_CMD_SOCKET` | `/tmp/starpi_cmd.sock` | `radio_app`'s command socket (`/run/starpi/starpi_cmd.sock` under Compose) |
| `SP_LORA_RECONNECT_DELAY` | `2` | Delay between attempts to reach `radio_app`, seconds |
| `SP_SIM_RATE` | `350` | Packets per second sent by the `sim` link |
| `SP_MAX_PAGE_SIZE` | `1000` | Upper bound on `limit` |
| `SP_LIVE_BUFFER` | `200` | Packets kept for websocket backfill |
| `SP_SERVE_WEB` | `false` | Serve the bundled dashboard at `/` (else `/` redirects to `/docs`) |
| `SP_LOG_LEVEL` | `INFO` | Log verbosity |

## API

### Telemetry

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/packets` | Stored packets, newest first |
| `GET` | `/api/packets/latest` | Most recent packet per message type |
| `GET` | `/api/packets/{id}` | A single packet |
| `DELETE` | `/api/packets` | Clear the store |
| `GET` | `/api/stats` | Counts by type, source and link |

`GET /api/packets` accepts `limit`, `offset`, `order` (`asc`/`desc`),
`since_us`, `until_us`, and the repeatable filters `src`, `type`,
`payload_type`, `link`. Filters accept enum names and are OR-ed together, so
`?src=S_IMU&src=S_BARO` (or `?src=S_IMU,S_BARO`) returns both.
`with_total=false` skips counting the matches (`total` is then `null`), which
halves the cost of paging through long histories. To page, prefer `after_id`
to `offset`: pass the previous page's last packet as `after_id` with its
`timestamp_us` as `since_us` (`order=asc`) or `until_us` (`order=desc`). Each
page then costs the same, where `offset` gets slower with every page.

`link` selects the transport a packet arrived on (`ble`, `lora`, `sim`: the
names in `SP_LINKS`), which is how a flight over one radio is read back
without the other's traffic: `?link=ble`. An unknown link name returns `400`.
With both radios up the same quantity is stored once per link it arrived on
(nothing is merged), so a client that wants one series per quantity filters
by `link`.

```sh
curl 'http://localhost:8000/api/packets?type=T_ALT_SPEED&limit=5'
```

```json
{
  "total": 376, "count": 1, "limit": 5, "offset": 0,
  "packets": [
    {
      "id": 371,
      "timestamp_us": 1789583292713217,
      "timestamp": 1789583292.713217,
      "received_at_us": 1789583292714002,
      "link": "ble",
      "payload_type": "P_FVEC2",
      "src": "S_BARO",
      "type": "T_ALT_SPEED",
      "payload": { "x": 110.2, "y": -1.4 }
    }
  ]
}
```

Payloads are typed by `payload_type`: scalars come through as JSON numbers,
booleans and strings as themselves, `P_FVEC2`/`P_FVEC3` as `{"x":…,"y":…[,"z":…]}`,
`P_ROCKET_STATE` (one byte, the `T_ROCKET_STATE` flight state) as the state's name
(`"RS_IDLE"` … `"RS_TOUCHDOWN"`, listed under `rocket_states` in `/api/enums`),
and `P_NONE` as `null`.

### Commands

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/commands/available` | Commands each link accepts |
| `POST` | `/api/commands` | Send a command to the rocket |
| `GET` | `/api/commands` | Command history |
| `GET` | `/api/commands/{id}` | A single command |

```sh
curl -X POST http://localhost:8000/api/commands \
  -H 'Content-Type: application/json' \
  -d '{"name": "cameras_on"}'
```

`link` may be set to pick a transport explicitly; otherwise the first connected
link that supports the command is used. A command that cannot be delivered
returns `503` and is recorded with status `failed`.

The rocket's commands take no arguments and are one byte on the wire, the same
on every link (`COMMAND_IDS` in `links/base.py`, mirroring `enum LoRaCommand`
in the firmware's `lora.h`):

| Command | Id | Effect |
| --- | --- | --- |
| `eject_a` | `0x01` | Fire ejection charge A |
| `eject_c` | `0x02` | Fire ejection charge C |
| `cut_main` | `0x03` | Fire the main parachute cutter |
| `cameras_on` | `0x04` | Turn the cameras on |
| `cameras_off` | `0x05` | Turn the cameras off |
| `sensor_calibration` | `0x06` | Calibrate the sensors |

The BLE link writes the id to the firmware's one writable characteristic and
also offers `raw_write` (`{"characteristic": "<uuid>", "data": "<hex>"}`, API
only). The simulator accepts the same commands and does nothing.

The LoRa link hands the command to `radio_app` as the JSON line
`{"command": <id>, "data": 0}` on its command socket; `bytes` in the response
is that line. `radio_app` transmits it in the ground station's next window and
the LoRa protocol has no acknowledgement yet, so `sent` means *handed to
radio_app*, not received by the rocket. A command is refused with `503` while
the rocket is not connected over LoRa, rather than left queued in `radio_app`
to go out whenever it reconnects. The LoRa command packet also carries a
64-bit argument that no command uses yet: `"args": {"data": <integer>}` sets
it. `radio_app` forwards any id, but the rocket only acts on the ones its
firmware knows.

### Live stream

`GET /ws` — a websocket that pushes JSON events:

```json
{"event": "packet", "data": { "...": "same shape as GET /api/packets" }}
```

The first message is
`{"event": "hello", "data": {"run": …, "links": …, "enums": …, "commands": …, "filter": …}}`,
followed by a replay of the last `?backfill=N` packets (default 20). Other
events: `command` when one is dispatched, `error` for an undecodable frame.
Send `ping` to get a `pong`.

`?link=ble,sim` restricts the stream — replay included — to those transports;
events that carry no link (`hello`, `pong`) always come through. An unknown
link name closes the socket with `1008` after an `error` event.

### Meta

`GET /api/health`, `GET /api/links`, and `GET /api/enums` (enum names, bit flags
and wire indices, so clients need not hardcode the protocol).

`run` (in `/api/health` and the websocket's `hello`) is the database file of
this run: it changes every time the backend starts. `rocket_time` in
`/api/health` is the rocket's clock as last heard, `{"timestamp_us", "age_us"}`
(`null` before the first packet of the run); timestamps are the rocket's own
and only become dates once GPS has set its clock, so clients should take
"now" from it rather than from their own clock.

At startup the backend runs SQLite's `PRAGMA quick_check` over the database in
the background (ingest does not wait for it). `storage` in `/api/health` reports
`state` as `checking`, `ok` or `corrupt`, with SQLite's findings in `problems`;
a corrupt file is also logged as an error. A corrupt database still takes live
packets, but history queries that reach its damaged pages fail with a 500.

## LoRa link

The radio is driven by the firmware's `radio_app`, not by this backend.
`links/lora.py` connects to its two Unix sockets and reconnects when it
restarts; the line formats are documented in `radio_app`'s
`telemetry_output.h` and `command_input.h`.

In `/api/health` and `/api/links` the link reports:

| Field | Meaning |
| --- | --- |
| `connected` | The rocket is on the LoRa link (`radio_app` completed the handshake and still hears it) |
| `radio_app` | `radio_app` is running and its telemetry socket is open |
| `radio_state` | Its protocol state: `disconnected`, `connecting`, `transmit`, `receive` (`null` without `radio_app`) |
| `last_error` | Why `connected` is false: `radio_app` unreachable, or running without the rocket |
| `packets`, `lost_packets` | LoRa data packets received, and missed (gaps in the rocket's sequence numbers) |
| `bad_lines` | Lines from `radio_app` that could not be read |
| `tilt_deg` | The rocket's tilt from vertical in the last packet (see below) |

A LoRa data packet is one fixed summary of the rocket's latest values
(`LoRaDataPacket` in the firmware's `lora.h`), sent many times a second. The
link turns it back into the `LogMessage` frames the rocket logged, so storage,
the API and the websocket see the same messages as over BLE:

| LoRa field | Message | Source | Payload |
| --- | --- | --- | --- |
| `imu.altitude`, `imu.vspeed` | `T_ALT_SPEED` | `S_IMU` | `P_FVEC2`: x altitude (m), y vertical speed (m/s) |
| `baro.p1`, `baro.p2` | `T_PRESSURE` | `S_BARO` | `P_FVEC2`: the two barometers (mbar) |
| `gps.latitude`, `gps.longitude` | `T_GPS` | `S_GPS` | `P_FVEC2`: x latitude, y longitude (degrees) |
| `state` | `T_ROCKET_STATE` | `S_PARA` | `P_ROCKET_STATE` |

* Units are the firmware's, as over BLE. Altitude, speed and pressure travel
  as 16-bit floats (11 significant bits): pressure in 0.5 mbar steps, altitude
  in 1 m steps above 1024 m and 2 m above 2048 m.
* Timestamps are the rocket's clock, never the ground's. Each group carries
  `dt`, its age in ms relative to the packet's transmit time, so a frame is
  stamped `tx_time + dt`; the flight state has no `dt` and is stamped
  `tx_time`. The firmware re-bases `dt` at every transmission, so a value it
  has not refreshed since the previous packet is stamped later than it was
  sampled, by at most its sensor's period.
* The rocket repeats its latest values in every packet. A group becomes a
  frame when its values change, and otherwise once a second, so LoRa adds at
  most a few frames per packet and a steady value still arrives often enough
  not to turn stale.
* `T_ALT_SPEED` is logged on the rocket by both the IMU and the barometer
  task; the packet does not say which wrote last and keeps it in its `imu`
  group, hence `S_IMU`.
* Pressure and GPS groups that are all zeros (not measured yet, no fix) and
  values that are not finite numbers are skipped.
* Not converted, because no `LogMessage` means the same: `imu.attitude`, the
  tilt from vertical in degrees (`T_ORIENTATION` is roll, pitch and yaw), only
  shown as `tilt_deg` in the link status. Acceleration, angular rate,
  orientation, temperature and the system log are not in the LoRa packet at
  all.

## Protocol

`src/protocol.py` implements the frame described in `spec/logger.h`:

```
| timestamp (8 B) | flags (2 B) | payload (0..N B) |   little-endian
```

`flags` packs enum *indices* — 4 bits payload type, 3 bits source, 4 bits
message type, from the least significant bit — matching the
`ceil(log2(n)) <= *_ENCODED_BITS` constraint in the header. The enum constants
themselves stay `1 << index` bit flags, which is what makes the mask-based
query filters work.

## Layout

```
spec/           firmware headers this backend mirrors
  logger.h        telemetry frame format
  Ble.hpp         BLE services, characteristics, device name
src/
  main.py       entrypoint (uvicorn)
  api.py        REST routes + websocket
  station.py    ingest pipeline, command dispatch
  protocol.py   logger.h frame codec
  db.py         SQLite store
  hub.py        websocket fan-out
  config.py     environment configuration
  links/
    base.py     transport interface
    ble.py      Bluetooth LE (Ble.hpp)
    lora.py     LoRa, through the firmware's radio_app
    sim.py      telemetry simulator
  web/index.html  dashboard (served only with SP_SERVE_WEB=true)
```
