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
IMAGES := starpi/gs-backend:latest starpi/gs-apache:latest starpi/gs-radio:latest
BUNDLE ?= starpi-images.tar.gz
# up and sim rebuild by default; BUILD=--no-build runs the images already here.
BUILD ?= --build
# Links `make sim` starts; `make sim2` is sim-ble,sim-lora.
SIM_LINKS ?= sim
# Shared with radio_app (radio/) for the LoRa link: it creates its sockets
# here, the backend reads them.
LORA_SOCKET_DIR ?= ./run
# The radio service runs when the LoRa link is asked for (SP_LINKS=ble,lora).
# `COMPOSE_PROFILES=` on the command line keeps it off, for radio_app on the host.
comma := ,
ifneq (,$(filter lora,$(subst $(comma), ,$(SP_LINKS))))
COMPOSE_PROFILES ?= lora
export COMPOSE_PROFILES
endif

.DEFAULT_GOAL := help
.PHONY: help up sim sim2 pi down restart build logs ps test setup-bl setup-lora hotspot lan tiles images bundle deploy load image flash

help:
	@echo "make up       build and start the stack on the rocket link (BLE; SP_LINKS=ble,lora adds LoRa and its radio service)"
	@echo "make sim      same, fed by the telemetry simulator instead (SP_SIM_RATE=350 pkt/s)"
	@echo "make sim2     the simulator as two radios: BLE that drops out in flight, and LoRa"
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
	@echo ""
	@echo "A ready SD card"
	@echo "make image    Raspberry Pi OS with the whole ground station on it (PASSWORD=..., see README)"
	@echo "make flash    write the image to an SD card (DEV=/dev/sdX)"

# --wait returns once the backend's healthcheck passes, so a broken start
# fails here instead of silently in the background.
up: setup-bl setup-lora
	$(COMPOSE) up -d $(BUILD) --wait
	@echo "Open MCT: http://localhost:$${FRONTEND_PORT:-8040}"

# The simulator gets its own database so it never mixes with flight data.
sim: setup-lora
	SP_LINKS=$(SIM_LINKS) SP_DB_PATH=/data/simulator.db $(COMPOSE) up -d $(BUILD) --wait
	@echo "Open MCT (simulator): http://localhost:$${FRONTEND_PORT:-8040}"

# One simulated flight heard over two radios (links/sim.py).
sim2:
	$(MAKE) sim SIM_LINKS=sim-ble,sim-lora

# On the Pi: the images come from `make deploy`/`make load` and are never built
# there, and the dashboard answers on the default HTTP port (http://starpi.gs on its networks).
pi:
	$(MAKE) up BUILD=--no-build FRONTEND_PORT=80

down:
	COMPOSE_PROFILES=lora $(COMPOSE) down

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

define with_qemu
@docker rm -f $(EMU_HOLD) >/dev/null 2>&1; \
trap 'docker rm -f $(EMU_HOLD) >/dev/null 2>&1' EXIT; \
docker run -d --rm --privileged --name $(EMU_HOLD) alpine \
	sh -c 'mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc && touch /ready && sleep infinity' >/dev/null && \
for i in $$(seq 50); do docker exec $(EMU_HOLD) test -f /ready 2>/dev/null && break; sleep 0.2; done && \
docker exec $(EMU_HOLD) test -f /ready && \
docker run --privileged --rm tonistiigi/binfmt --install $(EMU_ARCH) >/dev/null && \
echo "QEMU ready for $(PLATFORM)" && \
$(1)
endef

images:
	$(call with_qemu,COMPOSE_PROFILES=lora DOCKER_DEFAULT_PLATFORM=$(PLATFORM) $(COMPOSE) build)

bundle: images
	docker save $(IMAGES) | gzip > $(BUNDLE)
	@echo "Copy $(BUNDLE) next to the Makefile on the Pi, then: make load && make up BUILD=--no-build"

deploy: images
	docker save $(IMAGES) | gzip | ssh $(PI) 'gunzip | docker load'
	@echo "Images on $(PI). There: make up BUILD=--no-build (or make sim ...)"

load:
	gunzip -c $(BUNDLE) | docker load

# SD card image of the whole ground station (scripts/build-image.sh): Raspberry
# Pi OS Lite, Docker, a clone of this branch that pulls from origin, and the
# images above, started on first boot by scripts/firstboot.sh. The OS download
# is kept in $(IMAGE_DIR)/; delete it there to get a newer release.
OS_IMAGE_URL ?= https://downloads.raspberrypi.com/raspios_lite_arm64_latest
IMAGE_DIR := image
IMAGE ?= starpi.img.xz
BRANCH ?= $(shell git rev-parse --abbrev-ref HEAD)
# The card's links: ble,lora, or SP_LINKS from the command line, never this
# computer's .env (often sim).
IMAGE_LINKS := $(if $(filter command line,$(origin SP_LINKS)),$(SP_LINKS),ble$(comma)lora)
# Passed to the build through the environment, so any character is safe.
export PASSWORD PI_PASSWORD SSID WIFI_COUNTRY WIFI_SSID WIFI_PASSWORD

image:
	@if [ $${#PASSWORD} -lt 8 ] || [ $${#PASSWORD} -gt 63 ]; then \
		echo "make image PASSWORD=... (8 to 63 characters: the hotspot's, and the starpi login's unless PI_PASSWORD)"; exit 1; fi
	@git diff --quiet HEAD || echo "Uncommitted changes go into the images but not into the clone on the card."
	$(MAKE) bundle
	mkdir -p $(IMAGE_DIR)
	[ -f $(IMAGE_DIR)/raspios.img.xz ] || { curl -fL -o $(IMAGE_DIR)/raspios.img.xz.part $(OS_IMAGE_URL) && \
		mv $(IMAGE_DIR)/raspios.img.xz.part $(IMAGE_DIR)/raspios.img.xz; }
	rm -rf $(IMAGE_DIR)/repo
	git clone -q --branch $(BRANCH) . $(IMAGE_DIR)/repo
	git -C $(IMAGE_DIR)/repo remote set-url origin "$$(git remote get-url origin)"
	git -C $(IMAGE_DIR)/repo fetch -q --prune origin
	git -C $(IMAGE_DIR)/repo branch -q -u origin/$(BRANCH) || echo "$(BRANCH) is not on origin yet: push it before pulling on the Pi."
	$(call with_qemu,SSH_KEYS="$(if $(SSH_KEY),$$(cat $(SSH_KEY)))" docker run --rm --privileged -v /dev:/dev \
		-v "$(CURDIR)":/work -w /work -e PASSWORD -e PI_PASSWORD -e SSID -e WIFI_COUNTRY -e WIFI_SSID \
		-e WIFI_PASSWORD -e SP_LINKS=$(IMAGE_LINKS) -e SSH_KEYS -e OWNER=$$(id -u):$$(id -g) debian:trixie \
		sh scripts/build-image.sh $(IMAGE_DIR)/raspios.img.xz $(BUNDLE) $(IMAGE_DIR)/repo $(IMAGE))
	@echo "Flash $(IMAGE) with Raspberry Pi Imager (no OS customisation) or: make flash DEV=/dev/sdX"

# Writes the image to a whole SD card, never a partition: DEV=/dev/sdX or
# /dev/mmcblk0, as lsblk lists it. Asks before writing.
flash:
	@[ -b "$(DEV)" ] && [ "$$(lsblk -dno TYPE $(DEV))" = disk ] || { echo "make flash DEV=/dev/sdX (a whole disk, see lsblk)"; exit 1; }
	@[ "$$(lsblk -dno RM $(DEV) | tr -d ' ')" = 1 ] || case "$(DEV)" in /dev/mmcblk*) ;; *) echo "$(DEV) is not removable, refusing."; exit 1;; esac
	@! lsblk -no MOUNTPOINTS $(DEV) | grep -q . || { echo "$(DEV) has mounted partitions, unmount them first."; exit 1; }
	@lsblk -dno NAME,SIZE,MODEL $(DEV); printf "Erase $(DEV) and write $(IMAGE) to it? [y/N] "; read a; [ "$$a" = y ]
	xz -dc $(IMAGE) | sudo dd of=$(DEV) bs=4M conv=fsync status=progress
	@echo "Done: put the card in the Pi. First boot takes a few minutes, then http://starpi.gs on its network"
