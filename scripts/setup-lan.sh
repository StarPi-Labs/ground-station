#!/usr/bin/env sh
# Makes the Pi's Ethernet port serve its own network, so a laptop on a plain
# cable reaches the dashboard and SSH with no router and no network settings:
# http://starpi.local:8040, ssh starpi@starpi.local (or 10.43.0.1).
#
# Usage (as root): sh scripts/setup-lan.sh [interface]
#
# Without this, a direct cable leaves both ends retrying DHCP that nobody
# answers, and NetworkManager drops the link's addresses after each attempt.
# The port runs its own DHCP server, so do not plug it into a router's LAN
# while this is on. To undo: `nmcli connection delete starpi-lan` and remove
# /etc/NetworkManager/dnsmasq-shared.d/starpi-lan.conf.

set -eu

IFACE=${1:-eth0}
CON=starpi-lan
# Next to the hotspot's 10.42.0.0/24, so both can be up at once.
ADDRESS=10.43.0.1/24
# Answered by this network's own DNS server, for devices without mDNS.
DOMAIN=starpi.local
DNSMASQ_CONF=/etc/NetworkManager/dnsmasq-shared.d/$CON.conf

if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo sh $0 [interface]"
    exit 1
fi

if ! command -v nmcli >/dev/null 2>&1; then
    echo "nmcli command not found, the LAN setup needs NetworkManager."
    exit 1
fi

# Shared mode starts dnsmasq for DHCP; without it the connection fails to come up.
if ! command -v dnsmasq >/dev/null 2>&1; then
    echo "dnsmasq command not found, install it first: apt install dnsmasq-base"
    exit 1
fi

if ! nmcli device show "$IFACE" >/dev/null 2>&1; then
    echo "No network interface named $IFACE; pass it as the first argument."
    exit 1
fi

echo "Setting up the wired network on $IFACE..."

# Re-running replaces the profile, so the script doubles as "change settings".
nmcli connection delete "$CON" >/dev/null 2>&1 || true

# "shared" makes NetworkManager hand out addresses to whatever is plugged in.
# The priority puts it ahead of the stock DHCP-client profile on this port.
nmcli connection add \
    type ethernet ifname "$IFACE" con-name "$CON" \
    ipv4.method shared \
    ipv4.addresses "$ADDRESS" \
    ipv6.method link-local \
    connection.autoconnect yes \
    connection.autoconnect-priority 100 \
    >/dev/null

# NetworkManager's dnsmasq loads every file in dnsmasq-shared.d, the hotspot's
# too: naming the interface plus localise-queries makes each network answer
# with the Pi's address on that network, never the other one's.
mkdir -p "$(dirname "$DNSMASQ_CONF")"
printf 'interface-name=%s,%s\nlocalise-queries\n' "$DOMAIN" "$IFACE" > "$DNSMASQ_CONF"

# Unlike the hotspot this starts right away: a session over Wi-Fi is not
# touched, and one over this cable was not working without it anyway.
nmcli connection up "$CON" >/dev/null

echo "Wired network up on $IFACE, and on every boot."
echo "Dashboard: http://$DOMAIN:8040 (or http://${ADDRESS%/*}:8040), SSH: ssh <user>@$DOMAIN"
exit 0
