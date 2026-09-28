#!/usr/bin/env sh
# Turns the Pi's Wi-Fi into an access point that comes up on every boot, so
# phones and laptops in the field reach the dashboard without any router:
# join the network, then open http://starpi.local:8040.
#
# Usage (as root): sh scripts/setup-hotspot.sh <password> [ssid]
#
# Nothing changes until the next boot: the Pi stays on its current network, so
# an SSH session over Wi-Fi survives the run. Other saved Wi-Fi networks are
# kept at a lower priority and take over if the hotspot cannot start.

set -eu

PASSWORD=${1:-}
SSID=${2:-StarPi}
CON=starpi-hotspot
IFACE=wlan0
ADDRESS=10.42.0.1/24
# Answered by the hotspot's own DNS server, for devices without mDNS.
DOMAIN=starpi.local
DNSMASQ_CONF=/etc/NetworkManager/dnsmasq-shared.d/$CON.conf
# 5 GHz keeps the hotspot off the 2.4 GHz band that the BLE rocket link shares
# with Wi-Fi on the Pi's single radio. For 2.4 GHz-only devices use band bg,
# channel 6.
BAND=a
CHANNEL=36

if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo sh $0 <password> [ssid]"
    exit 1
fi

if ! command -v nmcli >/dev/null 2>&1; then
    echo "nmcli command not found, the hotspot needs NetworkManager."
    exit 1
fi

# Shared mode starts dnsmasq for DHCP and DNS; without it the hotspot fails to
# come up and the Pi silently falls back to its saved networks.
if ! command -v dnsmasq >/dev/null 2>&1; then
    echo "dnsmasq command not found, install it first: apt install dnsmasq-base"
    exit 1
fi

if [ ${#PASSWORD} -lt 8 ] || [ ${#PASSWORD} -gt 63 ]; then
    echo "The password must be 8 to 63 characters long."
    exit 1
fi

echo "Setting up the \"$SSID\" hotspot on $IFACE..."

# Re-running replaces the profile, so the script doubles as "change settings".
nmcli connection delete "$CON" >/dev/null 2>&1 || true

# The Pi's Broadcom chip only hands out WPA2 keys reliably with plain
# RSN/CCMP and PMF off; mixed modes leave clients stuck authenticating.
# "shared" makes NetworkManager run DHCP and DNS for the clients itself.
nmcli connection add \
    type wifi ifname "$IFACE" con-name "$CON" ssid "$SSID" \
    802-11-wireless.mode ap \
    802-11-wireless.band "$BAND" \
    802-11-wireless.channel "$CHANNEL" \
    802-11-wireless.powersave disable \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.proto rsn \
    wifi-sec.pairwise ccmp \
    wifi-sec.group ccmp \
    wifi-sec.pmf disable \
    wifi-sec.psk "$PASSWORD" \
    ipv4.method shared \
    ipv4.addresses "$ADDRESS" \
    ipv6.method disabled \
    connection.autoconnect yes \
    connection.autoconnect-priority 100 \
    >/dev/null

# NetworkManager runs dnsmasq for shared connections and loads every file in
# dnsmasq-shared.d, so this record goes live with the hotspot. It names the
# interface rather than an address: the wired network (setup-lan.sh) reads the
# same files, and localise-queries answers each network with the Pi's address
# on it.
mkdir -p "$(dirname "$DNSMASQ_CONF")"
printf 'interface-name=%s,%s\nlocalise-queries\n' "$DOMAIN" "$IFACE" > "$DNSMASQ_CONF"

echo "Hotspot ready, it starts on the next boot (or now: nmcli connection up $CON)."
echo "Dashboard: http://$DOMAIN:8040 (or http://${ADDRESS%/*}:8040)"
exit 0
