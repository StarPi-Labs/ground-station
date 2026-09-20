"""Synthetic link that fabricates telemetry — no rocket required.

Enable with ``SP_LINKS=sim`` (or ``SP_LINKS=ble,sim``) to exercise the API and
the web page without hardware. It emits frames through the same serializer the
firmware uses, so everything downstream sees real wire bytes.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from typing import Any

from links.base import BadCommand, CommandSpec, Link, PacketHandler, UnknownCommand
from protocol import LogMessage, MessagePayloadType, MessageType, SourceSubsystem

log = logging.getLogger(__name__)

COMMANDS = {
    "sensor_calibration": CommandSpec(
        name="sensor_calibration",
        description="Pretend to calibrate the sensors (simulator no-op).",
        params={"value": "optional int 0-255, echoed back (default 1)"},
    )
}


class SimLink(Link):
    name = "sim"

    def __init__(self, on_packet: PacketHandler, period: float = 0.5) -> None:
        super().__init__(on_packet)
        self._period = period
        self._task: asyncio.Task[None] | None = None
        self._t0 = time.monotonic()

    async def start(self) -> None:
        self._connected = True
        self._task = asyncio.create_task(self._run(), name="sim-link")
        log.info("simulator link running (period %.2fs)", self._period)

    async def stop(self) -> None:
        self._connected = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run(self) -> None:
        while True:
            for message in self._tick():
                await self._emit(message.to_bytes())
            await asyncio.sleep(self._period)

    def _tick(self) -> list[LogMessage]:
        elapsed = time.monotonic() - self._t0
        timestamp_us = time.time_ns() // 1_000

        def message(
            src: SourceSubsystem,
            msg_type: MessageType,
            payload_type: MessagePayloadType,
            payload: Any,
        ) -> LogMessage:
            return LogMessage(timestamp_us, payload_type, src, msg_type, payload)

        altitude = max(0.0, 120.0 * math.sin(elapsed / 20.0))
        jitter = lambda scale: random.uniform(-scale, scale)  # noqa: E731

        return [
            message(
                SourceSubsystem.S_IMU,
                MessageType.T_ACCELLERATION,
                MessagePayloadType.P_FVEC3,
                {"x": jitter(0.4), "y": jitter(0.4), "z": 9.81 + jitter(0.6)},
            ),
            message(
                SourceSubsystem.S_IMU,
                MessageType.T_GYRO,
                MessagePayloadType.P_FVEC3,
                {"x": jitter(5.0), "y": jitter(5.0), "z": jitter(5.0)},
            ),
            message(
                SourceSubsystem.S_IMU,
                MessageType.T_ORIENTATION,
                MessagePayloadType.P_FVEC3,
                {
                    "x": 20.0 * math.sin(elapsed / 7.0),
                    "y": 20.0 * math.cos(elapsed / 9.0),
                    "z": (elapsed * 12.0) % 360.0,
                },
            ),
            message(
                SourceSubsystem.S_BARO,
                MessageType.T_ALT_SPEED,
                MessagePayloadType.P_FVEC2,
                {"x": altitude, "y": 6.0 * math.cos(elapsed / 20.0)},
            ),
            message(
                SourceSubsystem.S_BARO,
                MessageType.T_PRESSURE,
                MessagePayloadType.P_FLOAT,
                1013.25 - altitude * 0.12 + jitter(0.3),
            ),
            message(
                SourceSubsystem.S_BARO,
                MessageType.T_TEMPERATURE,
                MessagePayloadType.P_FLOAT,
                21.5 - altitude * 0.0065 + jitter(0.2),
            ),
            message(
                SourceSubsystem.S_GPS,
                MessageType.T_GPS,
                MessagePayloadType.P_FVEC2,
                {"x": 45.4642 + jitter(0.0008), "y": 9.1900 + jitter(0.0008)},
            ),
            message(
                SourceSubsystem.S_OTHER,
                MessageType.T_SYSLOG,
                MessagePayloadType.P_STRING,
                f"simulated tick t+{elapsed:.1f}s, alt {altitude:.1f} m",
            ),
        ]

    def supported_commands(self) -> list[CommandSpec]:
        return list(COMMANDS.values())

    async def send_command(self, name: str, args: dict[str, Any]) -> bytes:
        # The simulator delivers nothing, so it validates as strictly as a real
        # link would: a command it accepts here must be one it advertises.
        if name not in COMMANDS:
            raise UnknownCommand(f"simulator link has no command {name!r}")

        raw = args.get("value", 1)
        try:
            value = int(raw)
        except (TypeError, ValueError):
            raise BadCommand(f"'value' must be an integer, got {raw!r}") from None
        if not 0 <= value <= 255:
            raise BadCommand("'value' must be in 0..255")

        log.info("simulator received command %s %s", name, args)
        return bytes([value])
