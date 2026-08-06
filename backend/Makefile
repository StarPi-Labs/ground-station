TAG=StarPi/gs-backend
VERSION=latest

.PHONY: build run setup-bl

build:
	docker build -t $(TAG):$(VERSION) .

run: setup-bl
	docker run \
		--rm \
		-v /var/run/dbus/system_bus_socket:/var/run/dbus/system_bus_socket \
		-it \
		$(TAG):$(VERSION)

setup-bl:
	./scripts/setup-bluetooth.sh
