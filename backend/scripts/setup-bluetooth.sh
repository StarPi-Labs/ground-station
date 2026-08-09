#!/usr/bin/env sh

echo "Setting up Bluetooth..."

# Check if bluetoothctl command is available
if ! command -v bluetoothctl >/dev/null 2>&1; then
    echo "bluetoothctl command not found, check BlueZ installation."
    exit 1
fi

# Get the current bluetooth status
output=$(bluetoothctl show 2>&1)

if [ $? -ne 0 ]; then
    echo "Failed to get bluetooth status."
    echo $output
    exit 1
fi

# Check if the controller is powered on
state=$(echo "$output" | awk '/Powered/ {print $2}')

if [ "$state" = "yes" ]; then
    echo "BLE is already enabled."
    exit 0
fi

# Enable the bluetooth controller
output=$({
    rfkill unblock bluetooth && \
    # Wait for a moment to ensure the controller is unblocked
    sleep 1 && \
    bluetoothctl power on
} 2>&1)

if [ $? -ne 0 ]; then
    echo "Failed to enable bluetooth."
    echo $output
    exit 1
fi

echo "Bluetooth enabled successfully."
exit 0
