"""LoRa link, through ``radio_app``.

The radio is not driven from here: ``radio_app`` (``radio/`` in this
repository) runs the LoRa protocol on the Pi and this link talks to it over
its two Unix sockets, JSON lines both ways:

* telemetry socket (``telemetry_output.h``): the protocol state on connect and
  on every change, and one line per data packet received from the rocket;
* command socket (``command_input.h``): ``{"command": <id>, "data": <u64>}``.

A LoRa data packet is not a ``LogMessage``: it is one fixed summary of the
latest values (``LoRaDataPacket`` in ``radio/src/lora.h``). It is turned
back into the frames the rocket logged, so everything downstream sees the same
wire bytes as on BLE:

    ============================  ================  ======  ==================
    LoRa field                    message type      source  payload
    ============================  ================  ======  ==================
    imu.altitude, imu.vspeed      T_ALT_SPEED       S_IMU   P_FVEC2 m, m/s
    baro.p1, baro.p2              T_PRESSURE        S_BARO  P_FVEC2 mbar, mbar
    gps.latitude, gps.longitude   T_GPS             S_GPS   P_FVEC2 degrees
    state                         T_ROCKET_STATE    S_PARA  P_ROCKET_STATE
    ============================  ================  ======  ==================

Values and units are the firmware's, as on BLE, but altitude, speed and
pressure travel as float16: 11 significant bits, so pressure comes in 0.5 mbar
steps and altitude in 1 m steps above 1024 m, 2 m above 2048 m.
``imu.attitude`` (tilt from vertical) has no ``LogMessage`` equivalent and is
only reported in :meth:`LoRaLink.status`.

Timestamps are the rocket's clock: a group was sampled at ``tx_time_ms +
dt_ms``, the rocket state (which has no ``dt``) is stamped ``tx_time_ms``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from config import config
from links.base import (
    COMMAND_IDS,
    ROCKET_COMMANDS,
    BadCommand,
    CommandSpec,
    Link,
    LinkError,
    PacketHandler,
    UnknownCommand,
)
from protocol import LogMessage, MessagePayloadType, MessageType, SourceSubsystem

log = logging.getLogger(__name__)

# The rocket sends its latest values in every packet, many times a second,
# whether they changed or not. A group becomes a frame when its values differ
# from the last frame, and otherwise this often (rocket clock), so a steady
# value is neither stored twenty times a second nor shown as stale.
REPEAT_US = 1_000_000

#: Longest wait for radio_app to take a command, in seconds.
COMMAND_TIMEOUT_S = 2.0

#: radio_app's lines are a few hundred bytes; a longer one is not its protocol.
MAX_LINE = 64 * 1024

# group -> (keys of its values, message type, source). In the firmware
# T_ALT_SPEED is logged by both the IMU and the barometer task and the packet
# does not say which wrote last; it keeps the values in its ``imu`` group.
GROUPS: dict[str, tuple[tuple[str, str], MessageType, SourceSubsystem]] = {
    "imu": (("altitude", "vspeed"), MessageType.T_ALT_SPEED, SourceSubsystem.S_IMU),
    "baro": (("p1", "p2"), MessageType.T_PRESSURE, SourceSubsystem.S_BARO),
    "gps": (("latitude", "longitude"), MessageType.T_GPS, SourceSubsystem.S_GPS),
}
# Groups the rocket has not filled yet are all zeros: no pressure reading, no
# GPS fix. Altitude 0 m at 0 m/s is a real reading (the pad), so not "imu".
ZERO_MEANS_UNSET = ("baro", "gps")

# The rocket's commands. radio_app queues them for the ground station's next
# transmit window and LoRa has no acknowledgement, so "sent" means handed over.
COMMANDS = dict(ROCKET_COMMANDS)


class LoRaLink(Link):
    name = "lora"

    def __init__(self, on_packet: PacketHandler) -> None:
        super().__init__(on_packet)
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()
        self._write_lock = asyncio.Lock()
        # Whether radio_app's telemetry socket is open, and the protocol state
        # it reports. `_connected` is narrower: the rocket is on the LoRa link.
        self._radio_app = False
        self._radio_state: str | None = None
        self._packets = 0
        self._lost = 0
        self._bad_lines = 0
        self._last_number: int | None = None
        self._tilt_deg: float | None = None
        # How well radio_app hears the rocket, from its last packet.
        self._rssi_dbm: float | None = None
        self._median_bps: float | None = None
        # message type -> (values, timestamp_us) of the last frame emitted
        self._emitted: dict[MessageType, tuple[Any, int]] = {}

    # --- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        self._stopping.clear()
        self._task = asyncio.create_task(self._run(), name="lora-link")

    async def stop(self) -> None:
        self._stopping.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self._offline()

    def status(self) -> dict[str, Any]:
        status = super().status()
        status.update(
            {
                "transport": "lora",
                # connected: the rocket is on the link. radio_app: the program
                # that drives the radio is running. radio_state: its protocol
                # state (disconnected, connecting, transmit, receive).
                "radio_app": self._radio_app,
                "radio_state": self._radio_state,
                "telemetry_socket": config.lora_tlm_socket,
                "command_socket": config.lora_cmd_socket,
                "packets": self._packets,
                "lost_packets": self._lost,
                "bad_lines": self._bad_lines,
                "tilt_deg": self._tilt_deg,
                "rssi_dbm": self._rssi_dbm,
                "median_bps": self._median_bps,
            }
        )
        return status

    # --- connection loop ---------------------------------------------------

    async def _run(self) -> None:
        """Follow radio_app's telemetry socket, reconnecting forever until stopped."""
        while not self._stopping.is_set():
            try:
                await self._session()
            except asyncio.CancelledError:
                raise
            except EOFError as exc:
                self._fail(str(exc))
            except OSError as exc:
                self._fail(f"radio_app is not reachable at {config.lora_tlm_socket}: {exc}")
            except Exception as exc:  # noqa: BLE001 - the loop must survive anything
                self._fail(f"radio_app telemetry failed: {exc}")
            finally:
                self._offline()

            if not self._stopping.is_set():
                await self._sleep_before_retry()

    async def _session(self) -> None:
        """Read one connection to the telemetry socket until it closes."""
        reader, writer = await asyncio.open_unix_connection(
            config.lora_tlm_socket, limit=MAX_LINE
        )
        try:
            self._radio_app = True
            self._last_error = "radio_app is running, its LoRa state is not known yet"
            log.info("connected to radio_app at %s", config.lora_tlm_socket)
            while True:
                line = await reader.readline()
                if not line:
                    raise EOFError("radio_app closed its telemetry socket (stopped?)")
                await self._on_line(line)
        finally:
            writer.close()

    async def _on_line(self, line: bytes) -> None:
        try:
            message = json.loads(line)
            kind = message["type"]
            if kind == "state":
                self._on_state(message)
            elif kind == "data":
                for frame in self._frames(message):
                    await self._emit(frame.to_bytes())
            # Any other type is a later addition to radio_app: ignored.
        except (ValueError, KeyError, TypeError) as exc:
            self._bad_lines += 1
            log.warning("dropping malformed radio_app line: %s (%r)", exc, line[:200])

    def _on_state(self, message: dict[str, Any]) -> None:
        state = str(message["state"])
        connected = bool(message["connected"])
        if connected != self._connected:
            log.info("rocket %s over LoRa", "connected" if connected else "disconnected")
        self._radio_state = state
        self._connected = connected
        if connected:
            self._last_error = None
        else:
            self._last_number = None
            self._last_error = (
                f"radio_app is running, but the rocket is not connected over LoRa (state: {state})"
            )

    def _frames(self, packet: dict[str, Any]) -> list[LogMessage]:
        """The LogMessage frames one LoRa data packet stands for (see the module docstring)."""
        tx_time_us = int(packet["tx_time_ms"]) * 1000
        number = int(packet["number"])
        if self._last_number is not None:
            # The number counts everything the rocket transmits, modulo 256.
            self._lost += (number - self._last_number - 1) % 256
        self._last_number = number
        self._packets += 1
        self._tilt_deg = packet["imu"]["attitude"]
        # Later additions to radio_app's data line: absent from an older one.
        self._rssi_dbm = packet.get("rssi_dbm")
        self._median_bps = packet.get("median_bps")

        frames: list[LogMessage] = []
        for group, (keys, msg_type, src) in GROUPS.items():
            fields = packet[group]
            values = tuple(fields[key] for key in keys)
            if any(value is None for value in values):
                continue  # not a finite number: nothing honest to store
            if group in ZERO_MEANS_UNSET and not any(values):
                continue
            # dt is in ms from the transmit time, on the rocket's clock. The
            # firmware re-bases it at every transmission, so a value that was
            # not refreshed since the previous packet is stamped later than it
            # was sampled, by at most its sensor's period.
            timestamp_us = max(0, tx_time_us + int(fields["dt_ms"]) * 1000)
            if self._due(msg_type, values, timestamp_us):
                frames.append(
                    LogMessage(
                        timestamp_us,
                        MessagePayloadType.P_FVEC2,
                        src,
                        msg_type,
                        {"x": values[0], "y": values[1]},
                    )
                )

        state = int(packet["state"])
        if self._due(MessageType.T_ROCKET_STATE, state, tx_time_us):
            frames.append(
                LogMessage(
                    tx_time_us,
                    MessagePayloadType.P_ROCKET_STATE,
                    SourceSubsystem.S_PARA,
                    MessageType.T_ROCKET_STATE,
                    state,
                )
            )
        # In the rocket's time order, like everything else the backend stores.
        frames.sort(key=lambda frame: frame.timestamp_us)
        return frames

    def _due(self, msg_type: MessageType, values: Any, timestamp_us: int) -> bool:
        """Whether these values are news: changed, or last sent REPEAT_US ago."""
        last = self._emitted.get(msg_type)
        # abs(): the rocket's clock steps back when it restarts.
        if last is not None and last[0] == values and abs(timestamp_us - last[1]) < REPEAT_US:
            return False
        self._emitted[msg_type] = (values, timestamp_us)
        return True

    def _fail(self, message: str) -> None:
        if message != self._last_error:  # retried every few seconds: log it once
            log.warning("%s; retrying every %gs", message, config.lora_reconnect_delay)
        self._last_error = message

    def _offline(self) -> None:
        self._radio_app = False
        self._radio_state = None
        self._connected = False
        self._last_number = None
        self._rssi_dbm = None
        self._median_bps = None

    async def _sleep_before_retry(self) -> None:
        try:
            await asyncio.wait_for(
                self._stopping.wait(), timeout=config.lora_reconnect_delay
            )
        except asyncio.TimeoutError:
            pass

    # --- commands ----------------------------------------------------------

    def supported_commands(self) -> list[CommandSpec]:
        return list(COMMANDS.values())

    async def send_command(self, name: str, args: dict[str, Any]) -> bytes:
        """Hand a command to radio_app; returns the JSON line written to its socket.

        Nothing comes back: radio_app sends it in its next transmit window and
        the LoRa protocol has no acknowledgement yet.
        """
        if name not in COMMANDS:
            raise UnknownCommand(f"LoRa link has no command {name!r}")

        line = self._encode_command(name, args)

        # radio_app would queue the command and transmit it whenever the
        # rocket next connects: refuse instead of firing something late.
        if not self._radio_app:
            raise LinkError(f"radio_app is not running (no socket at {config.lora_tlm_socket})")
        if not self._connected:
            raise LinkError(
                f"rocket is not connected over LoRa (radio_app state: {self._radio_state})"
            )

        async with self._write_lock:
            try:
                await asyncio.wait_for(self._write_command(line), timeout=COMMAND_TIMEOUT_S)
            except asyncio.TimeoutError:
                raise LinkError("radio_app did not take the command in time") from None
            except OSError as exc:
                raise LinkError(
                    f"radio_app command socket {config.lora_cmd_socket} failed: {exc}"
                ) from exc
        return line

    @staticmethod
    async def _write_command(line: bytes) -> None:
        # One connection per command: radio_app serves one client at a time.
        _reader, writer = await asyncio.open_unix_connection(config.lora_cmd_socket)
        try:
            writer.write(line)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    @staticmethod
    def _encode_command(name: str, args: dict[str, Any]) -> bytes:
        # The LoRa command packet carries a 64-bit argument next to the id; no
        # command uses it yet, so it is optional here and 0 by default.
        data = args.get("data", 0)
        if isinstance(data, bool) or not isinstance(data, int) or not 0 <= data < 1 << 64:
            raise BadCommand(f"'data' must be an integer from 0 to 2^64-1, got {data!r}")
        return (json.dumps({"command": COMMAND_IDS[name], "data": data}) + "\n").encode()
