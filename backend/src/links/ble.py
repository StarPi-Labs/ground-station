"""Bluetooth LE link, per ``spec/Ble.hpp``.

The log characteristic is READ/NOTIFY: we subscribe to notifications and also
do a single read on connect so a freshly started ground station immediately
shows the last value the rocket published. The calibration characteristic is
WRITE-only and carries commands.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic
from bleak.exc import BleakError

from config import config
from links.base import (
    BadCommand,
    CommandSpec,
    Link,
    LinkError,
    PacketHandler,
    UnknownCommand,
)

log = logging.getLogger(__name__)

# --- UUIDs, mirrored from Ble.hpp -----------------------------------------

LOG_SERVICE_UUID = "53cfc3a2-72dc-4bf0-805c-acc1f8ba9706"
LOG_CHARACTERISTIC_UUID = "53cfc3a2-72dc-4bf1-805c-acc1f8ba9706"

SENSOR_SERVICE_UUID = "53cfc3a2-72dd-4bf0-805c-acc1f8ba9706"
SENSOR_CALIBRATION_CHARACTERISTIC_UUID = "53cfc3a2-72dd-4bf1-805c-acc1f8ba9706"

#: Maximum frame the firmware will emit (LOG_MESSAGE_BUFFER_SIZE).
LOG_MESSAGE_BUFFER_SIZE = 256


COMMANDS = {
    "sensor_calibration": CommandSpec(
        name="sensor_calibration",
        description="Trigger the on-board sensor calibration routine.",
        params={"value": "optional int 0-255 written to the characteristic (default 1)"},
    ),
    "raw_write": CommandSpec(
        name="raw_write",
        description="Escape hatch: write arbitrary bytes to a characteristic.",
        params={
            "characteristic": "GATT characteristic UUID",
            "data": "hex string, e.g. '01ff'",
        },
    ),
}


class BLELink(Link):
    name = "ble"

    def __init__(self, on_packet: PacketHandler) -> None:
        super().__init__(on_packet)
        self._client: BleakClient | None = None
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()
        self._device_address: str | None = None
        self._write_lock = asyncio.Lock()

    # --- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        self._stopping.clear()
        self._task = asyncio.create_task(self._run(), name="ble-link")

    async def stop(self) -> None:
        self._stopping.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self._disconnect()

    def status(self) -> dict[str, Any]:
        status = super().status()
        status.update(
            {
                "transport": "bluetooth-le",
                "device_name": config.ble_device_name,
                "address": self._device_address,
            }
        )
        return status

    # --- connection loop ---------------------------------------------------

    async def _run(self) -> None:
        """Connect, stay connected, and reconnect forever until stopped."""
        while not self._stopping.is_set():
            try:
                device = await self._discover()
                if device is None:
                    self._last_error = (
                        f"device {config.ble_device_name!r} not found during scan"
                    )
                    log.warning("%s; retrying in %.0fs", self._last_error, config.ble_reconnect_delay)
                    await self._sleep_before_retry()
                    continue

                await self._session(device)
            except asyncio.CancelledError:
                raise
            except BleakError as exc:
                self._last_error = str(exc)
                log.warning("BLE error: %s", exc)
            except Exception as exc:  # noqa: BLE001 - the loop must survive anything
                self._last_error = str(exc)
                log.exception("unexpected BLE failure")
            finally:
                self._connected = False

            if not self._stopping.is_set():
                await self._sleep_before_retry()

    async def _discover(self) -> Any:
        if config.ble_address:
            log.info("looking for BLE device at %s", config.ble_address)
            return await BleakScanner.find_device_by_address(
                config.ble_address, timeout=config.ble_scan_timeout
            )

        log.info("scanning for BLE device %r", config.ble_device_name)
        return await BleakScanner.find_device_by_name(
            config.ble_device_name, timeout=config.ble_scan_timeout
        )

    async def _session(self, device: Any) -> None:
        """Hold one connection open until it drops or we are told to stop."""
        disconnected = asyncio.Event()

        def on_disconnect(_client: BleakClient) -> None:
            log.warning("BLE device disconnected")
            disconnected.set()

        async with BleakClient(device, disconnected_callback=on_disconnect) as client:
            self._client = client
            self._device_address = getattr(device, "address", None)
            self._connected = True
            self._last_error = None
            log.info("connected to %s (%s)", getattr(device, "name", "?"), self._device_address)

            await client.start_notify(LOG_CHARACTERISTIC_UUID, self._on_notify)

            # The characteristic is also READ: pick up whatever is already there.
            try:
                initial = await client.read_gatt_char(LOG_CHARACTERISTIC_UUID)
                if initial:
                    await self._emit(bytes(initial))
            except BleakError as exc:
                log.debug("initial read failed (not fatal): %s", exc)

            stop_waiter = asyncio.create_task(self._stopping.wait())
            drop_waiter = asyncio.create_task(disconnected.wait())
            try:
                await asyncio.wait(
                    {stop_waiter, drop_waiter}, return_when=asyncio.FIRST_COMPLETED
                )
            finally:
                for waiter in (stop_waiter, drop_waiter):
                    waiter.cancel()
                self._connected = False
                self._client = None

    async def _on_notify(self, _char: BleakGATTCharacteristic, data: bytearray) -> None:
        if not data:
            return
        if len(data) > LOG_MESSAGE_BUFFER_SIZE:
            log.warning("oversized BLE frame (%d B), dropping", len(data))
            return
        await self._emit(bytes(data))

    async def _sleep_before_retry(self) -> None:
        try:
            await asyncio.wait_for(
                self._stopping.wait(), timeout=config.ble_reconnect_delay
            )
        except asyncio.TimeoutError:
            pass

    async def _disconnect(self) -> None:
        client, self._client = self._client, None
        if client is not None and client.is_connected:
            try:
                await client.disconnect()
            except BleakError as exc:
                log.debug("disconnect failed: %s", exc)
        self._connected = False

    # --- commands ----------------------------------------------------------

    def supported_commands(self) -> list[CommandSpec]:
        return list(COMMANDS.values())

    async def send_command(self, name: str, args: dict[str, Any]) -> bytes:
        if name not in COMMANDS:
            raise UnknownCommand(f"BLE link has no command {name!r}")

        characteristic, payload = self._encode_command(name, args)

        client = self._client
        if client is None or not client.is_connected:
            raise LinkError("BLE link is not connected")

        async with self._write_lock:
            try:
                await client.write_gatt_char(characteristic, payload, response=True)
            except BleakError as exc:
                raise LinkError(f"BLE write failed: {exc}") from exc
        return payload

    @staticmethod
    def _encode_command(name: str, args: dict[str, Any]) -> tuple[str, bytes]:
        if name == "sensor_calibration":
            value = args.get("value", 1)
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise BadCommand(f"'value' must be an integer, got {value!r}") from None
            if not 0 <= value <= 255:
                raise BadCommand("'value' must be in 0..255")
            return SENSOR_CALIBRATION_CHARACTERISTIC_UUID, bytes([value])

        # raw_write
        characteristic = args.get("characteristic")
        if not characteristic:
            raise BadCommand("'characteristic' is required")
        hex_data = str(args.get("data", ""))
        try:
            payload = bytes.fromhex(hex_data)
        except ValueError:
            raise BadCommand(f"'data' is not valid hex: {hex_data!r}") from None
        if not payload:
            raise BadCommand("'data' must contain at least one byte")
        return str(characteristic), payload
