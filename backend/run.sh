#!/bin/sh

# Turning on Bluetooth
echo "Turning on Bluetooth..."

output=$(rfkill unblock bluetooth && \
    # Wait for a second to ensure the Bluetooth service is ready
    sleep 1 && \
    bluetoothctl power on 2>&1)

if [ $? -ne 0 ]; then
    echo "Failed to turn on Bluetooth: $output" >&2
    exit 1
fi

echo "Bluetooth is on."

# Run
echo "Starting the application..."
docker compose up
