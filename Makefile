# Entry points for the whole ground station. docker-compose.yml stays the
# source of truth for the services; these targets only wrap the commands.
# Compose settings (SP_LINKS, FRONTEND_PORT, ...) pass straight through, from
# .env, the shell or the command line: `make up FRONTEND_PORT=9000`.

-include .env

COMPOSE ?= docker compose
# Where `make deploy` sends the images, and the CPU they are built for
# (linux/arm/v7 for a 32-bit Raspberry Pi OS).
PI ?= starpi.local
PLATFORM ?= linux/arm64
IMAGES := starpi/gs-backend:latest starpi/gs-apache:latest
BUNDLE ?= starpi-images.tar.gz
# up and sim rebuild by default; BUILD=--no-build runs the images already here.
BUILD ?= --build
# Shared with the firmware's radio_app for the LoRa link: it creates its
# sockets here (`radio_app $(abspath $(LORA_SOCKET_DIR))`), the backend reads them.
LORA_SOCKET_DIR ?= ./run

.DEFAULT_GOAL := help
.PHONY: help up sim pi down restart build logs ps test setup-bl setup-lora hotspot lan tiles images bundle deploy load

help:
	@echo "make up       build and start the stack on the rocket link (BLE; SP_LINKS=ble,lora adds LoRa)"
	@echo "make sim      same, fed by the telemetry simulator instead (SP_SIM_RATE=350 pkt/s)"
	@echo "make down     stop and remove the containers (data in backend/data stays)"
	@echo "make restart  restart the running containers"
	@echo "make build    build the images only"
	@echo "make logs     follow the logs (S=backend for one service)"
	@echo "make ps       show the containers and their health"
	@echo "make test     run the flight tracking tests"
	@echo "make hotspot  start a Wi-Fi hotspot on boot (PASSWORD=..., SSID=StarPi)"
	@echo "make lan      serve a network on the Ethernet port, for a direct cable (IFACE=eth0)"
	@echo "make tiles    download the offline launch site map (LAT=... LON=... RADIUS=5 km), then rebuild"
	@echo ""
	@echo "Pi without internet: build here, run there"
	@echo "make deploy   build the images for the Pi and load them over SSH (PI=starpi.local)"
	@echo "make bundle   same images into $(BUNDLE), to carry over by hand"
	@echo "make load     on the Pi: load $(BUNDLE)"
	@echo "make pi       on the Pi: start from the loaded images, Open MCT on port 80"
	@echo "make up BUILD=--no-build   same on the default port (sim too)"

# --wait returns once the backend's healthcheck passes, so a broken start
# fails here instead of silently in the background.
up: setup-bl setup-lora
	$(COMPOSE) up -d $(BUILD) --wait
	@echo "Open MCT: http://localhost:$${FRONTEND_PORT:-8040}"

# The simulator gets its own database so it never mixes with flight data.
sim: setup-lora
	SP_LINKS=sim SP_DB_PATH=/data/simulator.db $(COMPOSE) up -d $(BUILD) --wait
	@echo "Open MCT (simulator): http://localhost:$${FRONTEND_PORT:-8040}"

# On the Pi: the images come from `make deploy`/`make load` and are never built
# there, and the dashboard answers on the default HTTP port (http://starpi.local).
pi:
	$(MAKE) up BUILD=--no-build FRONTEND_PORT=80

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart

build:
	$(COMPOSE) build

logs:
	$(COMPOSE) logs -f $(S)

ps:
	$(COMPOSE) ps

test:
	node --test openmct/flight/flight-state.test.js

setup-bl:
	$(MAKE) -C backend setup-bl

# Created here, as this user: a directory Docker has to create for the mount
# belongs to root, and radio_app could not put its sockets in it.
setup-lora:
	mkdir -p "$(LORA_SOCKET_DIR)"

# Host setup, not a container: needs sudo and NetworkManager.
hotspot:
	sudo sh scripts/setup-hotspot.sh "$(PASSWORD)" "$(or $(SSID),StarPi)"

lan:
	sudo sh scripts/setup-lan.sh "$(or $(IFACE),eth0)"

# Offline map for Launch Control, baked into the frontend image by the next
# build. Needs internet and Docker (the pmtiles CLI runs from its image). The
# default site is the competition's pad A, also the simulator's pad (backend/src/links/sim.py).
LAT ?= $(or $(SP_PAD_LAT),39.392547)
LON ?= $(or $(SP_PAD_LON),-8.289517)
RADIUS ?= 5

tiles:
	python3 scripts/fetch-tiles.py $(LAT) $(LON) $(RADIUS)

# Cross-builds for the Pi, with QEMU running the Pi's programs during the
# build. The kernel forgets QEMU once the last binfmt_misc mount goes away, and
# some hosts (NixOS) never mount it, so a helper container holds a mount open
# for the length of the build and is removed afterwards, even on failure.
EMU_HOLD := starpi-binfmt-hold
EMU_ARCH := $(word 2,$(subst /, ,$(PLATFORM)))

images:
	@docker rm -f $(EMU_HOLD) >/dev/null 2>&1; \
	trap 'docker rm -f $(EMU_HOLD) >/dev/null 2>&1' EXIT; \
	docker run -d --rm --privileged --name $(EMU_HOLD) alpine \
		sh -c 'mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc && touch /ready && sleep infinity' >/dev/null && \
	for i in $$(seq 50); do docker exec $(EMU_HOLD) test -f /ready 2>/dev/null && break; sleep 0.2; done && \
	docker exec $(EMU_HOLD) test -f /ready && \
	docker run --privileged --rm tonistiigi/binfmt --install $(EMU_ARCH) >/dev/null && \
	echo "QEMU ready for $(PLATFORM)" && \
	DOCKER_DEFAULT_PLATFORM=$(PLATFORM) $(COMPOSE) build

bundle: images
	docker save $(IMAGES) | gzip > $(BUNDLE)
	@echo "Copy $(BUNDLE) next to the Makefile on the Pi, then: make load && make up BUILD=--no-build"

deploy: images
	docker save $(IMAGES) | gzip | ssh $(PI) 'gunzip | docker load'
	@echo "Images on $(PI). There: make up BUILD=--no-build (or make sim ...)"

load:
	gunzip -c $(BUNDLE) | docker load
