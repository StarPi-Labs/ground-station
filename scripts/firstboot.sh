#!/usr/bin/env sh
# First boot of a card made by `make image` (scripts/build-image.sh): sets up
# the Pi's networks and starts the ground station from the images on the card.
#
# Run as root by starpi-firstboot.service while /etc/starpi/firstboot.env is
# there. The file is deleted once the images are loaded, so a boot that fails
# before that tries again on the next one. Output: journalctl -u starpi-firstboot

set -eu

ENV=/etc/starpi/firstboot.env
. "$ENV"
cd "$REPO"

# Only loading the images below has to succeed: a network that fails to come
# up must not keep the station from starting.

# Wi-Fi stays blocked until a country is set, and the hotspot's 5 GHz channel
# needs one anyway.
raspi-config nonint do_wifi_country "$WIFI_COUNTRY" || echo "Could not set the Wi-Fi country to $WIFI_COUNTRY."

# A network with internet for git pull and apt, below the hotspot: reach it
# with `sudo nmcli connection down starpi-hotspot` (see README.md).
if [ -n "$WIFI_SSID" ]; then
    nmcli connection delete "$WIFI_SSID" >/dev/null 2>&1 || true
    nmcli connection add \
        type wifi ifname wlan0 con-name "$WIFI_SSID" ssid "$WIFI_SSID" \
        wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$WIFI_PASSWORD" \
        connection.autoconnect yes \
        >/dev/null && echo "Saved the \"$WIFI_SSID\" Wi-Fi network." ||
        echo "Could not save the \"$WIFI_SSID\" Wi-Fi network."
fi

# Fails to bring the port up without a cable in it, but the profile is saved
# and starts on its own once one is plugged in.
sh scripts/setup-lan.sh eth0 || echo "No cable in the Ethernet port, the wired network starts when one is plugged in."
sh scripts/setup-hotspot.sh "$PASSWORD" "$SSID" || echo "Could not set up the hotspot."
# Otherwise it would only come up on the next boot.
nmcli connection up starpi-hotspot >/dev/null || echo "The hotspot did not start, it tries again on the next boot."

# As root: make pi checks the controller too, but as starpi it cannot
# unblock it.
sh scripts/setup-bluetooth.sh || true

runuser -u "$USER_NAME" -- make load
rm -f starpi-images.tar.gz "$ENV"

# The containers restart with Docker on every boot from here on. make pi
# stops before creating them if the Bluetooth setup fails, so then they are
# created without it; a failed start shows in `make ps` and `make logs`.
runuser -u "$USER_NAME" -- make pi ||
    runuser -u "$USER_NAME" -- docker compose up -d ||
    echo "The stack did not start, see make ps and make logs."
echo "Ground station ready: http://starpi.gs"
