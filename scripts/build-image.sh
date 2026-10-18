#!/usr/bin/env sh
# Builds an SD card image of the whole ground station: Raspberry Pi OS Lite
# with Docker, a clone of this repository and the stack's images. Flash it,
# boot the Pi, and the dashboard comes up on its own; scripts/firstboot.sh
# sets up the networks and starts the stack on that first boot.
#
# Run by `make image`, inside a privileged Debian container with QEMU
# registered for arm64, which runs the Pi's own apt in a chroot.
#
# Usage (as root): sh scripts/build-image.sh <raspios.img.xz> <images.tar.gz> <clone> <output.img.xz>
#
# Settings, from the environment: PASSWORD (the hotspot's and the starpi
# login's, unless PI_PASSWORD), SSID, WIFI_COUNTRY, WIFI_SSID and
# WIFI_PASSWORD (a network with internet, for git pull), SSH_KEYS (lines for
# authorized_keys), SP_LINKS, and OWNER (uid:gid the output is given to).

set -eu

BASE=$1
BUNDLE=$2
CLONE=$3
OUT=$4
WORK=${OUT%.xz}
# Room for Docker and the images; the Pi grows the partition to the whole card
# on its first boot.
GROW=3G
ROOT=/mnt/starpi
USER_NAME=starpi
REPO=/home/$USER_NAME/ground-station

PI_PASSWORD=${PI_PASSWORD:-${PASSWORD:-}}
SSID=${SSID:-StarPi}
WIFI_COUNTRY=${WIFI_COUNTRY:-IT}
SP_LINKS=${SP_LINKS:-ble,lora}

if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo sh $0 <raspios.img.xz> <images.tar.gz> <clone> <output.img.xz>"
    exit 1
fi

if [ ${#PASSWORD} -lt 8 ] || [ ${#PASSWORD} -gt 63 ]; then
    echo "The hotspot password (PASSWORD) must be 8 to 63 characters long."
    exit 1
fi

echo "Installing the image tools..."
apt-get update -qq >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fdisk e2fsprogs xz-utils >/dev/null

LOOP=
cleanup() {
    umount -R "$ROOT" 2>/dev/null || true
    [ -z "$LOOP" ] || losetup -d "$LOOP"
}
trap cleanup EXIT

echo "Unpacking $BASE..."
xz -dc -T0 "$BASE" > "$WORK"
truncate -s +$GROW "$WORK"
# The root partition is the last one: stretch it over the added space.
echo ', +' | sfdisk -q -N 2 "$WORK"

LOOP=$(losetup -fP --show "$WORK")
for i in $(seq 50); do [ -b "${LOOP}p2" ] && break; sleep 0.1; done
# e2fsck exits 1 when it fixed something, which is fine before a resize.
e2fsck -fy "${LOOP}p2" >/dev/null || [ $? -eq 1 ]
resize2fs "${LOOP}p2" >/dev/null

mkdir -p "$ROOT"
mount "${LOOP}p2" "$ROOT"
mount "${LOOP}p1" "$ROOT/boot/firmware"
for d in dev dev/pts proc sys; do mount --bind "/$d" "$ROOT/$d"; done

# Restored at the end: an empty machine id is what makes the Pi's first boot
# a first boot (new SSH host keys, among others).
MACHINE_ID=$(cat "$ROOT/etc/machine-id")
mv "$ROOT/etc/resolv.conf" "$ROOT/etc/resolv.conf.starpi"
cp /etc/resolv.conf "$ROOT/etc/resolv.conf"
# No service starts inside the chroot.
printf '#!/bin/sh\nexit 101\n' > "$ROOT/usr/sbin/policy-rc.d"
chmod +x "$ROOT/usr/sbin/policy-rc.d"

echo "Installing Docker and git on the Pi's system..."
chroot "$ROOT" env USER_NAME="$USER_NAME" PI_PASSWORD="$PI_PASSWORD" sh -eu <<'EOF'
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
# Docker's own packages, as on the computers that build the images: Engine,
# Compose, and Buildx so the stack can also be rebuilt on the Pi.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git >/dev/null
apt-get clean
rm -rf /var/lib/apt/lists/*

# The image's user is pi, which Raspberry Pi OS renames on first boot through
# cloud-init or a dialog on the screen. Renamed here instead, and both are
# turned off, so the card boots straight into a working login.
usermod -l "$USER_NAME" -d "/home/$USER_NAME" -m -s /bin/bash pi
groupmod -n "$USER_NAME" pi
usermod -aG docker,bluetooth "$USER_NAME"
echo "$USER_NAME:$PI_PASSWORD" | chpasswd
touch /etc/cloud/cloud-init.disabled
systemctl disable -q userconfig.service

systemctl enable -q ssh.service docker.service
EOF

echo starpi > "$ROOT/etc/hostname"
sed -i 's/^127\.0\.1\.1.*/127.0.1.1\t\tstarpi/' "$ROOT/etc/hosts"

# The LoRa radio is on the SPI bus (radio/src/board.h).
grep -q '^dtparam=spi=on' "$ROOT/boot/firmware/config.txt" ||
    echo 'dtparam=spi=on' >> "$ROOT/boot/firmware/config.txt"

echo "Copying the repository and the images..."
cp -a "$CLONE" "$ROOT$REPO"
cp "$BUNDLE" "$ROOT$REPO/starpi-images.tar.gz"
# Compose and the Makefile read it, so `make up` on the Pi keeps these too.
# The radio service's profile goes there too, so plain `docker compose up`
# starts the same services as the Makefile.
printf 'SP_LINKS=%s\nFRONTEND_PORT=80\n' "$SP_LINKS" > "$ROOT$REPO/.env"
case ",$SP_LINKS," in *,lora,*) echo 'COMPOSE_PROFILES=lora' >> "$ROOT$REPO/.env";; esac
if [ -n "${SSH_KEYS:-}" ]; then
    mkdir -p "$ROOT/home/$USER_NAME/.ssh"
    printf '%s\n' "$SSH_KEYS" > "$ROOT/home/$USER_NAME/.ssh/authorized_keys"
    chmod 700 "$ROOT/home/$USER_NAME/.ssh"
    chmod 600 "$ROOT/home/$USER_NAME/.ssh/authorized_keys"
fi
chroot "$ROOT" chown -R "$USER_NAME:$USER_NAME" "/home/$USER_NAME"

# The first boot setup. It lives outside the clone, so a later git checkout
# cannot change it, and runs while its settings file is there.
install -D -m 0755 scripts/firstboot.sh "$ROOT/usr/local/lib/starpi/firstboot.sh"
install -d -m 0700 "$ROOT/etc/starpi"
# Shell-quoted, since firstboot.sh sources it: a ' in a password survives.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
cat > "$ROOT/etc/starpi/firstboot.env" <<EOF
REPO=$(quote "$REPO")
USER_NAME=$(quote "$USER_NAME")
PASSWORD=$(quote "$PASSWORD")
SSID=$(quote "$SSID")
WIFI_COUNTRY=$(quote "$WIFI_COUNTRY")
WIFI_SSID=$(quote "${WIFI_SSID:-}")
WIFI_PASSWORD=$(quote "${WIFI_PASSWORD:-}")
EOF
chmod 600 "$ROOT/etc/starpi/firstboot.env"
cat > "$ROOT/etc/systemd/system/starpi-firstboot.service" <<'EOF'
[Unit]
Description=StarPi ground station first boot setup
Wants=network-online.target
After=network-online.target NetworkManager.service docker.service bluetooth.service
Requires=docker.service
ConditionPathExists=/etc/starpi/firstboot.env

[Service]
Type=oneshot
ExecStart=/usr/local/lib/starpi/firstboot.sh
TimeoutStartSec=30min

[Install]
WantedBy=multi-user.target
EOF
chroot "$ROOT" systemctl enable -q starpi-firstboot.service

rm "$ROOT/usr/sbin/policy-rc.d"
mv "$ROOT/etc/resolv.conf.starpi" "$ROOT/etc/resolv.conf"
echo "$MACHINE_ID" > "$ROOT/etc/machine-id"
rm -f "$ROOT/var/lib/dbus/machine-id"

df -h "$ROOT" | tail -1 | awk '{print "Root partition: " $3 " used, " $4 " free"}'
cleanup
LOOP=
trap - EXIT

echo "Compressing $OUT..."
xz -f -T0 "$WORK"
# Handed back to whoever ran make, not left to the container's root.
[ -z "${OWNER:-}" ] || chown "$OWNER" "$OUT"
echo "Image ready: $OUT"
