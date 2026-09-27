# Entry points for the whole ground station. docker-compose.yml stays the
# source of truth for the services; these targets only wrap the commands.
# Compose settings (SP_LINKS, FRONTEND_PORT, ...) pass straight through, from
# .env, the shell or the command line: `make up FRONTEND_PORT=9000`.

COMPOSE ?= docker compose

.DEFAULT_GOAL := help
.PHONY: help up sim down restart build logs ps test setup-bl hotspot

help:
	@echo "make up       build and start the stack on the rocket link (BLE)"
	@echo "make sim      same, fed by the telemetry simulator instead"
	@echo "make down     stop and remove the containers (data in backend/data stays)"
	@echo "make restart  restart the running containers"
	@echo "make build    build the images only"
	@echo "make logs     follow the logs (S=backend for one service)"
	@echo "make ps       show the containers and their health"
	@echo "make test     run the flight estimation tests"
	@echo "make hotspot  start a Wi-Fi hotspot on boot (PASSWORD=..., SSID=StarPi)"

# --wait returns once the backend's healthcheck passes, so a broken start
# fails here instead of silently in the background.
up: setup-bl
	$(COMPOSE) up -d --build --wait
	@echo "Open MCT: http://localhost:$${FRONTEND_PORT:-8040}"

# The simulator gets its own database so it never mixes with flight data.
sim:
	SP_LINKS=sim SP_DB_PATH=/data/simulator.db $(COMPOSE) up -d --build --wait
	@echo "Open MCT (simulator): http://localhost:$${FRONTEND_PORT:-8040}"

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

# Host setup, not a container: needs sudo and NetworkManager.
hotspot:
	sudo sh scripts/setup-hotspot.sh "$(PASSWORD)" "$(or $(SSID),StarPi)"
