"""Synthetic link that fabricates telemetry — no rocket required.

Enable with ``SP_LINKS=sim`` (or ``SP_LINKS=ble,sim``) to exercise the API and
the web page without hardware. It emits frames through the same serializer the
firmware uses, so everything downstream sees real wire bytes.

The telemetry follows a complete flight, repeated every ``FLIGHT_CYCLE_S``
seconds: pad, motor burn, coast, apogee (~285 m), parachute descent, landing.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from dataclasses import dataclass
from typing import Any

from links.base import BadCommand, CommandSpec, Link, PacketHandler, UnknownCommand
from protocol import LogMessage, MessagePayloadType, MessageType, SourceSubsystem

log = logging.getLogger(__name__)

G = 9.81

# One simulated flight, repeated forever: seconds from the start of the cycle.
FLIGHT_CYCLE_S = 90.0
PAD_S = 20.0  # waiting on the pad
BURN_S = 2.2  # motor burn
BURN_ACCEL = 4.0 * G  # proper acceleration felt during the burn
CHUTE_SPEED = 8.0  # descent rate under the parachute, m/s
CHUTE_OPEN_S = 2.0  # time for the parachute to slow the fall to CHUTE_SPEED
WIND_SPEED = 3.0  # horizontal drift while airborne, m/s
STATUS_PERIOD_S = 5.0

# Launch site: somewhere near Milan, 120 m above sea level.
PAD_LAT = 45.4642
PAD_LON = 9.1900
PAD_ALTITUDE_M = 120.0

# Derived once: end of the burn, apogee, touchdown.
_BURN_SPEED = (BURN_ACCEL - G) * BURN_S
_BURN_ALT = 0.5 * (BURN_ACCEL - G) * BURN_S**2
_COAST_S = _BURN_SPEED / G
APOGEE_M = _BURN_ALT + _BURN_SPEED**2 / (2 * G)
APOGEE_T = PAD_S + BURN_S + _COAST_S
_CHUTE_DROP = 0.5 * CHUTE_SPEED * CHUTE_OPEN_S  # height lost while the chute opens
LANDING_T = APOGEE_T + CHUTE_OPEN_S + (APOGEE_M - _CHUTE_DROP) / CHUTE_SPEED


@dataclass(slots=True)
class FlightState:
    phase: str
    altitude: float  # above the pad, m
    speed: float  # vertical, m/s
    accel: float  # proper acceleration along the rocket axis, m/s²
    spin: float  # roll rate, °/s
    roll_deg: float
    sway: float  # 0..1, how much the rocket swings (under the chute)
    drift_m: float  # horizontal distance blown downwind


def flight_state(t: float) -> FlightState:
    """Ideal state of the simulated flight ``t`` seconds into the cycle."""
    airborne = min(max(t, PAD_S), LANDING_T) - PAD_S
    drift = WIND_SPEED * airborne

    if t < PAD_S:
        return FlightState("PAD", 0.0, 0.0, G, 0.0, 0.0, 0.0, 0.0)

    if t < PAD_S + BURN_S:
        dt = t - PAD_S
        return FlightState(
            "BOOST",
            0.5 * (BURN_ACCEL - G) * dt**2,
            (BURN_ACCEL - G) * dt,
            BURN_ACCEL,
            90.0 * dt,
            45.0 * dt**2,
            0.0,
            drift,
        )

    if t < APOGEE_T:
        dt = t - PAD_S - BURN_S
        # Free fall apart from a little drag: the accelerometer reads almost nothing.
        return FlightState(
            "COAST",
            _BURN_ALT + _BURN_SPEED * dt - 0.5 * G * dt**2,
            _BURN_SPEED - G * dt,
            0.4,
            198.0,
            (45.0 * BURN_S**2 + 198.0 * dt) % 360.0,
            0.0,
            drift,
        )

    if t < LANDING_T:
        dt = t - APOGEE_T
        if dt < CHUTE_OPEN_S:
            # The parachute snaps open: a brief jolt, then a steady sink.
            speed = -CHUTE_SPEED * dt / CHUTE_OPEN_S
            altitude = APOGEE_M - 0.5 * CHUTE_SPEED * dt**2 / CHUTE_OPEN_S
            accel = G + 2.0 * G * math.exp(-dt * 3.0)
        else:
            speed = -CHUTE_SPEED
            altitude = APOGEE_M - _CHUTE_DROP - CHUTE_SPEED * (dt - CHUTE_OPEN_S)
            accel = G
        return FlightState(
            "DESCENT", max(0.0, altitude), speed, accel, 20.0, (dt * 20.0) % 360.0, 1.0, drift
        )

    return FlightState("LANDED", 0.0, 0.0, G, 0.0, 0.0, 0.0, drift)


def _pressure_hpa(altitude_m: float) -> float:
    """International standard atmosphere, troposphere."""
    return 1013.25 * (1.0 - 2.25577e-5 * altitude_m) ** 5.25588


def _offset(lat: float, lon: float, *, north_m: float, east_m: float) -> tuple[float, float]:
    """Move a coordinate by a few metres (flat-earth approximation)."""
    dlat = north_m / 111_320.0
    dlon = east_m / (111_320.0 * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon

COMMANDS = {
    "sensor_calibration": CommandSpec(
        name="sensor_calibration",
        description="Pretend to calibrate the sensors (simulator no-op).",
        params={"value": "optional int 0-255, echoed back (default 1)"},
    )
}


class SimLink(Link):
    name = "sim"

    def __init__(self, on_packet: PacketHandler, period: float = 0.2) -> None:
        super().__init__(on_packet)
        self._period = period
        self._task: asyncio.Task[None] | None = None
        self._t0 = time.monotonic()
        self._phase: str | None = None
        self._next_status = 0.0

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
        t = (time.monotonic() - self._t0) % FLIGHT_CYCLE_S
        timestamp_us = time.time_ns() // 1_000
        state = flight_state(t)
        jitter = lambda scale: random.uniform(-scale, scale)  # noqa: E731

        def message(
            src: SourceSubsystem,
            msg_type: MessageType,
            payload_type: MessagePayloadType,
            payload: Any,
        ) -> LogMessage:
            return LogMessage(timestamp_us, payload_type, src, msg_type, payload)

        altitude = state.altitude + jitter(0.3)
        accel = state.accel
        spin = state.spin
        lat, lon = _offset(PAD_LAT, PAD_LON, north_m=state.drift_m * 0.3, east_m=state.drift_m)

        messages = [
            message(
                SourceSubsystem.S_IMU,
                MessageType.T_ACCELLERATION,
                MessagePayloadType.P_FVEC3,
                {"x": jitter(0.4), "y": jitter(0.4), "z": accel + jitter(0.6)},
            ),
            message(
                SourceSubsystem.S_IMU,
                MessageType.T_GYRO,
                MessagePayloadType.P_FVEC3,
                {"x": jitter(2.0) + state.sway * 8.0, "y": jitter(2.0), "z": spin + jitter(2.0)},
            ),
            message(
                SourceSubsystem.S_IMU,
                MessageType.T_ORIENTATION,
                MessagePayloadType.P_FVEC3,
                {
                    "x": state.sway * 25.0 * math.sin(t * 1.3) + jitter(0.5),
                    "y": state.sway * 25.0 * math.cos(t * 0.9) + jitter(0.5),
                    "z": (state.roll_deg + jitter(0.5)) % 360.0,
                },
            ),
            message(
                SourceSubsystem.S_BARO,
                MessageType.T_ALT_SPEED,
                MessagePayloadType.P_FVEC2,
                {"x": PAD_ALTITUDE_M + altitude, "y": state.speed + jitter(0.4)},
            ),
            message(
                SourceSubsystem.S_BARO,
                MessageType.T_PRESSURE,
                MessagePayloadType.P_FLOAT,
                _pressure_hpa(PAD_ALTITUDE_M + altitude) + jitter(0.05),
            ),
            message(
                SourceSubsystem.S_BARO,
                MessageType.T_TEMPERATURE,
                MessagePayloadType.P_FLOAT,
                21.5 - altitude * 0.0065 + jitter(0.1),
            ),
            message(
                SourceSubsystem.S_GPS,
                MessageType.T_GPS,
                MessagePayloadType.P_FVEC2,
                {"x": lat + jitter(0.00002), "y": lon + jitter(0.00002)},
            ),
        ]

        # Syslog on every phase change, plus a heartbeat every few seconds.
        if state.phase != self._phase:
            self._phase = state.phase
            self._next_status = t + STATUS_PERIOD_S
            messages.append(self._syslog(timestamp_us, f"phase {state.phase}"))
        elif t >= self._next_status:
            self._next_status = t + STATUS_PERIOD_S
            messages.append(
                self._syslog(timestamp_us, f"{state.phase.lower()} alt {altitude:.1f} m")
            )

        return messages

    @staticmethod
    def _syslog(timestamp_us: int, text: str) -> LogMessage:
        return LogMessage(
            timestamp_us,
            MessagePayloadType.P_STRING,
            SourceSubsystem.S_OTHER,
            MessageType.T_SYSLOG,
            text,
        )

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
