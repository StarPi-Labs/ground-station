TAG=StarPi/gs-backend
VERSION=latest
PORT?=8000
DATA?=$(PWD)/data

.PHONY: build run run-sim dev setup-bl

build:
	docker build -t $(TAG):$(VERSION) .

run: setup-bl
	docker run \
		--rm \
		-v /var/run/dbus/system_bus_socket:/var/run/dbus/system_bus_socket \
		-v $(DATA):/data \
		-p $(PORT):8000 \
		-it \
		$(TAG):$(VERSION)

# Same image, but fed by the built-in telemetry simulator instead of a rocket.
run-sim:
	docker run \
		--rm \
		-v $(DATA):/data \
		-p $(PORT):8000 \
		-e SP_LINKS=sim \
		-it \
		$(TAG):$(VERSION)

# Run straight off the host, no container.
dev: setup-bl
	python src/main.py

setup-bl:
	sh ./scripts/setup-bluetooth.sh
