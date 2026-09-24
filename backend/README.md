# Backend API

A JSON REST + websocket API for the rocket's MCU. It ingests telemetry frames
over Bluetooth LE, stores them in SQLite, pushes every new packet to connected
websocket clients, and forwards commands back to the rocket.

```
rocket ──BLE──> link ──> decode (Proto.hpp) ──> SQLite ──> GET /api/packets
                                       └──> websocket /ws
browser ──POST /api/commands──> link ──BLE──> rocket
```

The transport sits behind a `Link` interface (`src/links/`), so LoRa can be
added later without touching the API, the decoder or the storage layer.

## Prerequisites

* Docker >= 29.*: for running the backend in a container.
* BlueZ >= 5.55: for Bluetooth communication with the mcu.
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
flight phase shows up in the frontend.

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
| `SP_DB_PATH` | `data/starpi.db` | SQLite file (`/data/starpi.db` in Docker) |
| `SP_LINKS` | `ble` | Comma-separated links to start: `ble`, `sim` |
| `SP_BLE_DEVICE_NAME` | `John StarPi's Rocket` | Device name to scan for |
| `SP_BLE_ADDRESS` | — | Connect to this MAC directly, skipping the name scan |
| `SP_BLE_SCAN_TIMEOUT` | `10` | Scan timeout, seconds |
| `SP_BLE_RECONNECT_DELAY` | `5` | Delay between reconnect attempts, seconds |
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

`link` selects the transport a packet arrived on (`ble`, `sim`, … — the names
in `SP_LINKS`), which is how a flight over one radio is read back without the
other's traffic: `?link=ble`. An unknown link name returns `400`.

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
  -d '{"name": "sensor_calibration", "args": {"value": 1}}'
```

`link` may be set to pick a transport explicitly; otherwise the first connected
link that supports the command is used. A command that cannot be delivered
returns `503` and is recorded with status `failed`.

BLE commands: `sensor_calibration` (writes one byte to the calibration
characteristic) and `raw_write` (`{"characteristic": "<uuid>", "data": "<hex>"}`).

### Live stream

`GET /ws` — a websocket that pushes JSON events:

```json
{"event": "packet", "data": { "...": "same shape as GET /api/packets" }}
```

The first message is
`{"event": "hello", "data": {"links": …, "enums": …, "commands": …, "filter": …}}`,
followed by a replay of the last `?backfill=N` packets (default 20). Other
events: `command` when one is dispatched, `error` for an undecodable frame.
Send `ping` to get a `pong`.

`?link=ble,sim` restricts the stream — replay included — to those transports;
events that carry no link (`hello`, `pong`) always come through. An unknown
link name closes the socket with `1008` after an `error` event.

### Meta

`GET /api/health`, `GET /api/links`, and `GET /api/enums` (enum names, bit flags
and wire indices, so clients need not hardcode the protocol).

## Protocol

`src/protocol.py` implements the frame described in `spec/Proto.hpp`:

```
| timestamp (8 B) | flags (2 B) | payload (0..N B) |   little-endian
```

`flags` packs enum *indices* — 4 bits payload type, 3 bits source, 3 bits
message type, from the least significant bit — matching the
`ceil(log2(n)) <= *_ENCODED_BITS` constraint in the header. The enum constants
themselves stay `1 << index` bit flags, which is what makes the mask-based
query filters work.

## Layout

```
spec/           firmware headers this backend mirrors
  Proto.hpp       telemetry frame format
  Ble.hpp         BLE services, characteristics, device name
src/
  main.py       entrypoint (uvicorn)
  api.py        REST routes + websocket
  station.py    ingest pipeline, command dispatch
  protocol.py   Proto.hpp frame codec
  db.py         SQLite store
  hub.py        websocket fan-out
  config.py     environment configuration
  links/
    base.py     transport interface
    ble.py      Bluetooth LE (Ble.hpp)
    sim.py      telemetry simulator
  web/index.html  dashboard (served only with SP_SERVE_WEB=true)
```
