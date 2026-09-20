# Ground Station Software

This repository contains all software components of the ground station.

## Hardware

This project uses:
- [Raspberry Pi 4](https://www.raspberrypi.com/products/raspberry-pi-4-model-b/) as the main computer
- LoRa module hat for communication with rocket mcu
- (TODO): An HDMI monitor for quick data visualization and debugging

## Software

The software stack involves the following components:
- [Open MCT](https://nasa.github.io/openmct/) for telemetry visualization
- Python backend for data processing and communication with the LoRa module and Bluetooth LE
- SQLite database for data storage and retrieval

### Backend

`backend/` holds the Python service: it decodes telemetry frames, stores them
in SQLite, pushes them to websocket clients and forwards commands back to the
rocket. `cd backend && make build && make run` brings it up on
<http://localhost:8000>, where `/docs` is the generated API reference (`/`
redirects there).

Open MCT is the telemetry front end; the backend also bundles a bare-bones
dashboard for quick checks, which is opt-in — `SP_SERVE_WEB=true` serves it at
`/`, and `make run-web` does that for you. See
[backend/README.md](backend/README.md) for the API, the protocol and the full
list of settings.

> [!NOTE]
> Below is the README from the Open MCT QuickStart repository (since this is a fork).
> It will eventually modifed/removed.

# Open MCT QuickStart

This repository contains a quick way to get started with Open MCT, integrated with:
* [Open MCT](https://nasa.github.io/openmct/)
* [CouchDB](https://couchdb.apache.org/)
* [YAMCS](https://yamcs.org/)
* [Apache HTTP Server](https://httpd.apache.org/)

## Prerequisites

* [Docker](https://docs.docker.com/get-docker/)

## Getting Started

1. Clone this repository
2. cd to the repository directory (usually `openmct-quickstart`)
3. Run `docker compose up`
4. Wait a bit for the containers to start ⏱️
5. Open a browser to http://localhost:8040
6. Enter the username/password `testuser`/`NasaIsCool!`

## Nuts and Bolts

The `docker-compose.yml` file in this repository defines a set of containers that work together to provide a complete Open MCT environment. The containers are:
* `openmct` - Builds the Open MCT web application into a shared volume (and quits)
* `couchdb` - The CouchDB database used by Open MCT to persist objects created by the operator.
* `yamcs` - The YAMCS telemetry & commanding server used by Open MCT to retrieve telemetry data.
* `simulator` - A simple python simulator that generates telemetry data for YAMCS to serve.
* `apache` - The Apache HTTP server used to serve the Open MCT web application, and to proxy requests to YAMCS and CouchDB.

Hosted websites are available at the following URLs:
* The OpenMCT web application is served from http://localhost:8040
* The YAMCS web application is served from http://localhost:8040/yamcs
* The Apache server status is served from http://localhost:8040/server-status
* The CouchDB web application is served from http://localhost:8040/couchdb/_utils (with username `admin` and password `password`)

## Diagram

```mermaid
graph TD
    A[Apache HTTP Server] -- serves --> B[Open MCT Web Application]
    A -- proxies --> C[CouchDB Database]
    A -- proxies --> D[YAMCS Telemetry & Commanding Server]
    E[Python Simulator] -- generates telemetry data --> D
    F[Docker Compose] -- orchestrates --> A
    F -- orchestrates --> B
    F -- orchestrates --> C
    F -- orchestrates --> D
    F -- orchestrates --> E

    B -- "HTTP Traffic & JSON Storage" --> C
    D -- "HTTP Traffic & JSON Storage" --> B

    click B "http://localhost:8040" "OpenMCT Web Application"
    click C "http://localhost:8040/couchdb/_utils" "CouchDB"
    click D "http://localhost:8040/yamcs" "YAMCS"
    click A "http://localhost:8040/server-status" "Apache Server Status"
