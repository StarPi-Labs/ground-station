"""Synthetic link that fabricates telemetry — no rocket required.

Enable with ``SP_LINKS=sim`` (or ``SP_LINKS=ble,sim``) to exercise the API and
the web page without hardware. It emits frames through the same serializer the
firmware uses, so everything downstream sees real wire bytes.

The telemetry follows a complete flight, repeated every ``FLIGHT_CYCLE_S``
seconds: pad, motor burn, coast, apogee (~3000 m), drogue and main parachute
descent, landing.

``SP_LINKS=sim-ble,sim-lora`` flies the same flight over two simulated radios,
to exercise everything that deals with two links: ``sim-ble`` is the full-rate
stream and drops out when the rocket is out of Bluetooth range, ``sim-lora``
is what the LoRa link would make of the same flight, heard all the way.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import struct
import time
from dataclasses import dataclass
from typing import Any

from config import config
from links.base import (
    COMMAND_IDS,
    ROCKET_COMMANDS,
    CommandSpec,
    Link,
    LinkError,
    PacketHandler,
    UnknownCommand,
)
from links.lora import LoRaLink
from protocol import LogMessage, MessagePayloadType, MessageType, RocketState, SourceSubsystem

log = logging.getLogger(__name__)

G = 9.81
MG_PER_MS2 = 1000.0 / G  # the accelerometer reports milli-g
MDPS_PER_DPS = 1000.0  # the gyroscope reports milli-degrees per second

# One simulated flight, repeated forever: seconds from the start of the cycle.
# Sized for the real rocket's target: apogee ~3000 m, dual-deploy recovery.
FLIGHT_CYCLE_S = 250.0
PAD_S = 20.0  # waiting on the pad
BURN_S = 3.3  # motor burn
BURN_ACCEL = 8.0 * G  # proper acceleration felt during the burn
DROGUE_SPEED = 25.0  # descent rate under the drogue, m/s
MAIN_SPEED = 6.0  # descent rate under the main parachute, m/s
MAIN_ALTITUDE = 450.0  # the main opens below this height, m
DEPLOY_S = 2.0  # time for a parachute to settle the fall to its rate
WIND_SPEED = 3.0  # horizontal drift while airborne, m/s
STATUS_PERIOD_S = 5.0
ROCKET_STATE_PERIOD_S = 1.0  # T_ROCKET_STATE: on every change, and this often

# The mix of message types, as sample rates in Hz: the IMU at the flight
# firmware's 100 Hz task rate, logging three vectors, and the barometer faster
# than its 20 Hz task. It is scaled to the total packet rate asked for
# (SP_SIM_RATE, 350 pkt/s by default, above the real rocket's ~300).
RATES_HZ: dict[MessageType, float] = {
    MessageType.T_ACCELLERATION: 100.0,
    MessageType.T_GYRO: 100.0,
    MessageType.T_ORIENTATION: 100.0,
    MessageType.T_ALT_SPEED: 40.0,
    MessageType.T_PRESSURE: 40.0,
    MessageType.T_TEMPERATURE: 10.0,
    MessageType.T_GPS: 10.0,
}


def scaled_rates(total: float) -> dict[MessageType, float]:
    """RATES_HZ scaled so the message types add up to ``total`` pkt/s."""
    factor = total / sum(RATES_HZ.values())
    return {msg_type: hz * factor for msg_type, hz in RATES_HZ.items()}

# The two simulated radios (sim-ble, sim-lora).
BLE_RANGE_M = 300.0  # above this height the rocket is out of Bluetooth range
LORA_PACKET_HZ = 5.0  # LoRa data packets per second
# How long before a packet's transmission each of its groups was sampled, ms.
LORA_AGE_MS = {"imu": 10, "baro": 25, "gps": 80}
LORA_FC_ID = 252  # the flight computer's id in the firmware's LoRa protocol

TICK_S = 0.02  # how often due samples are sent, in a batch like BLE notifications
MAX_BACKLOG_S = 1.0  # samples older than this are skipped, not replayed

# Launch site, set by SP_PAD_* (see .env.example); competition pad A by default.
PAD_LAT = config.pad_lat
PAD_LON = config.pad_lon
PAD_ALTITUDE_M = config.pad_altitude_m

# Derived once: end of the burn, apogee, parachute events, touchdown. No drag:
# the burn is tuned so the ideal coast peaks near the target.
_BURN_SPEED = (BURN_ACCEL - G) * BURN_S
_BURN_ALT = 0.5 * (BURN_ACCEL - G) * BURN_S**2
_COAST_S = _BURN_SPEED / G
APOGEE_M = _BURN_ALT + _BURN_SPEED**2 / (2 * G)
APOGEE_T = PAD_S + BURN_S + _COAST_S
_DROGUE_SET_ALT = APOGEE_M - 0.5 * DROGUE_SPEED * DEPLOY_S
_MAIN_T = APOGEE_T + DEPLOY_S + (_DROGUE_SET_ALT - MAIN_ALTITUDE) / DROGUE_SPEED
_MAIN_SET_ALT = MAIN_ALTITUDE - 0.5 * (DROGUE_SPEED + MAIN_SPEED) * DEPLOY_S
LANDING_T = _MAIN_T + DEPLOY_S + _MAIN_SET_ALT / MAIN_SPEED


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
            60.0 * dt,
            30.0 * dt**2,
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
            (30.0 * BURN_S**2 + 198.0 * dt) % 360.0,
            0.0,
            drift,
        )

    if t < LANDING_T:
        # Parachutes snap open with a jolt, then the fall settles to their rate.
        dt = t - APOGEE_T
        if dt < DEPLOY_S:
            speed = -DROGUE_SPEED * dt / DEPLOY_S
            altitude = APOGEE_M - 0.5 * DROGUE_SPEED * dt**2 / DEPLOY_S
            accel = G + 2.0 * G * math.exp(-dt * 3.0)
        elif t < _MAIN_T:
            speed = -DROGUE_SPEED
            altitude = _DROGUE_SET_ALT - DROGUE_SPEED * (dt - DEPLOY_S)
            accel = G
        elif t < _MAIN_T + DEPLOY_S:
            dm = t - _MAIN_T
            slowing = (DROGUE_SPEED - MAIN_SPEED) / DEPLOY_S
            speed = -DROGUE_SPEED + slowing * dm
            altitude = MAIN_ALTITUDE - DROGUE_SPEED * dm + 0.5 * slowing * dm**2
            accel = G + 3.0 * G * math.exp(-dm * 3.0)
        else:
            speed = -MAIN_SPEED
            altitude = _MAIN_SET_ALT - MAIN_SPEED * (t - _MAIN_T - DEPLOY_S)
            accel = G
        return FlightState(
            "DESCENT", max(0.0, altitude), speed, accel, 20.0, (dt * 20.0) % 360.0, 1.0, drift
        )

    return FlightState("LANDED", 0.0, 0.0, G, 0.0, 0.0, 0.0, drift)


def rocket_state(t: float) -> RocketState:
    """The state the flight firmware would report ``t`` seconds into the cycle."""
    if t < PAD_S:
        return RocketState.RS_IDLE
    if t < PAD_S + BURN_S:
        return RocketState.RS_BOOST
    if t < APOGEE_T:
        return RocketState.RS_COAST
    if t < _MAIN_T:
        return RocketState.RS_DROGUE
    if t < LANDING_T:
        return RocketState.RS_MAIN
    return RocketState.RS_TOUCHDOWN


def _pressure_hpa(altitude_m: float) -> float:
    """International standard atmosphere, troposphere."""
    return 1013.25 * (1.0 - 2.25577e-5 * altitude_m) ** 5.25588


def _offset(lat: float, lon: float, *, north_m: float, east_m: float) -> tuple[float, float]:
    """Move a coordinate by a few metres (flat-earth approximation)."""
    dlat = north_m / 111_320.0
    dlon = east_m / (111_320.0 * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon

_t0: float | None = None


def _flight_start() -> float:
    """Monotonic time the simulated rocket was switched on: one flight and one
    rocket clock, whichever simulated links are listening to it."""
    global _t0
    if _t0 is None:
        _t0 = time.monotonic()
    return _t0


def _float16(value: float) -> float:
    """``value`` as it comes out of a LoRa packet's 16-bit float."""
    return struct.unpack("<e", struct.pack("<e", value))[0]


# The rocket's commands, all accepted and none acted on.
COMMANDS = {
    name: CommandSpec(name, f"{spec.description} Simulator no-op.")
    for name, spec in ROCKET_COMMANDS.items()
}


class SimLink(Link):
    name = "sim"

    def __init__(self, on_packet: PacketHandler, rate: float = 350.0) -> None:
        """``rate``: total packets per second, spread over the types as in RATES_HZ."""
        super().__init__(on_packet)
        self._rates = scaled_rates(rate)
        self._task: asyncio.Task[None] | None = None
        self._t0 = _flight_start()
        self._next_due = {msg_type: self._t0 for msg_type in self._rates}
        self._phase: str | None = None
        self._next_status = 0.0
        self._rocket_state: RocketState | None = None
        self._next_rocket_state = 0.0

    async def start(self) -> None:
        self._connected = True
        self._task = asyncio.create_task(self._run(), name="sim-link")
        log.info("simulator link running (%.0f pkt/s)", sum(self._rates.values()))

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
            now = time.monotonic()
            messages = self._due(now)
            if self._heard(flight_state((now - self._t0) % FLIGHT_CYCLE_S)):
                for message in messages:
                    await self._emit(message.to_bytes())
            await asyncio.sleep(TICK_S)

    def _heard(self, state: FlightState) -> bool:
        """Whether the rocket is in range; what it sends meanwhile is lost."""
        return True

    def _due(self, now: float) -> list[LogMessage]:
        """Every sample whose time has come, oldest first."""
        samples: list[tuple[float, MessageType]] = []
        for msg_type, hz in self._rates.items():
            period = 1.0 / hz
            due = self._next_due[msg_type]
            if now - due > MAX_BACKLOG_S:
                # Fell far behind (a stalled ingest): skip ahead rather than
                # flood the station with a burst of stale samples.
                due = now
            while due <= now:
                samples.append((due, msg_type))
                due += period
            self._next_due[msg_type] = due
        samples.sort(key=lambda sample: sample[0])

        messages = [self._sample(msg_type, at) for at, msg_type in samples]
        for extra in (self._status(now), self._state(now)):
            if extra is not None:
                messages.append(extra)
        return messages

    def _timestamp_us(self, at: float) -> int:
        """Microseconds since the link started, like a flight computer whose
        clock GPS has not set: the ground station must not rely on the date.
        From the sample's own schedule, not the moment its batch is sent."""
        return int((at - self._t0) * 1_000_000)

    def _sample(self, msg_type: MessageType, at: float) -> LogMessage:
        """One reading of ``msg_type`` taken at monotonic time ``at``."""
        t = (at - self._t0) % FLIGHT_CYCLE_S
        state = flight_state(t)
        jitter = lambda scale: random.uniform(-scale, scale)  # noqa: E731

        def message(
            src: SourceSubsystem, payload_type: MessagePayloadType, payload: Any
        ) -> LogMessage:
            return LogMessage(self._timestamp_us(at), payload_type, src, msg_type, payload)

        # The same noisy altitude feeds every barometer reading.
        altitude = state.altitude + jitter(0.3)

        if msg_type is MessageType.T_ACCELLERATION:
            return message(
                SourceSubsystem.S_IMU,
                MessagePayloadType.P_FVEC3,
                # In milli-g, as the rocket's accelerometer reports it.
                {
                    "x": jitter(0.4) * MG_PER_MS2,
                    "y": jitter(0.4) * MG_PER_MS2,
                    "z": (state.accel + jitter(0.6)) * MG_PER_MS2,
                },
            )
        if msg_type is MessageType.T_GYRO:
            return message(
                SourceSubsystem.S_IMU,
                MessagePayloadType.P_FVEC3,
                # In mdps, as the rocket's gyroscope reports it.
                {
                    "x": (jitter(2.0) + state.sway * 8.0) * MDPS_PER_DPS,
                    "y": jitter(2.0) * MDPS_PER_DPS,
                    "z": (state.spin + jitter(2.0)) * MDPS_PER_DPS,
                },
            )
        if msg_type is MessageType.T_ORIENTATION:
            return message(
                SourceSubsystem.S_IMU,
                MessagePayloadType.P_FVEC3,
                {
                    "x": state.sway * 25.0 * math.sin(t * 1.3) + jitter(0.5),
                    "y": state.sway * 25.0 * math.cos(t * 0.9) + jitter(0.5),
                    "z": (state.roll_deg + jitter(0.5)) % 360.0,
                },
            )
        if msg_type is MessageType.T_ALT_SPEED:
            return message(
                SourceSubsystem.S_BARO,
                MessagePayloadType.P_FVEC2,
                {"x": PAD_ALTITUDE_M + altitude, "y": state.speed + jitter(0.4)},
            )
        if msg_type is MessageType.T_PRESSURE:
            return message(
                SourceSubsystem.S_BARO,
                MessagePayloadType.P_FVEC2,  # the two barometers, like the firmware
                {
                    "x": _pressure_hpa(PAD_ALTITUDE_M + altitude) + jitter(0.05),
                    "y": _pressure_hpa(PAD_ALTITUDE_M + altitude) + 0.3 + jitter(0.05),
                },
            )
        if msg_type is MessageType.T_TEMPERATURE:
            return message(
                SourceSubsystem.S_BARO,
                MessagePayloadType.P_FVEC2,
                {
                    "x": 21.5 - altitude * 0.0065 + jitter(0.1),
                    "y": 21.9 - altitude * 0.0065 + jitter(0.1),
                },
            )
        if msg_type is MessageType.T_GPS:
            lat, lon = _offset(
                PAD_LAT, PAD_LON, north_m=state.drift_m * 0.3, east_m=state.drift_m
            )
            return message(
                SourceSubsystem.S_GPS,
                MessagePayloadType.P_FVEC2,
                {"x": lat + jitter(0.00002), "y": lon + jitter(0.00002)},
            )
        raise ValueError(f"simulator cannot produce {msg_type.name}")

    def _status(self, now: float) -> LogMessage | None:
        """Syslog on every phase change, plus a heartbeat every few seconds."""
        t = (now - self._t0) % FLIGHT_CYCLE_S
        state = flight_state(t)
        timestamp_us = self._timestamp_us(now)
        if state.phase != self._phase:
            self._phase = state.phase
            self._next_status = t + STATUS_PERIOD_S
            return self._syslog(timestamp_us, f"phase {state.phase}")
        if t >= self._next_status:
            self._next_status = t + STATUS_PERIOD_S
            return self._syslog(timestamp_us, f"{state.phase.lower()} alt {state.altitude:.1f} m")
        return None

    def _state(self, now: float) -> LogMessage | None:
        """T_ROCKET_STATE on every state change, and every ROCKET_STATE_PERIOD_S."""
        t = (now - self._t0) % FLIGHT_CYCLE_S
        state = rocket_state(t)
        if state is self._rocket_state and t < self._next_rocket_state:
            return None
        self._rocket_state = state
        self._next_rocket_state = t + ROCKET_STATE_PERIOD_S
        return LogMessage(
            self._timestamp_us(now),
            MessagePayloadType.P_ROCKET_STATE,
            SourceSubsystem.S_PARA,
            MessageType.T_ROCKET_STATE,
            state.name,
        )

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

        log.info("simulator received command %s", name)
        return bytes([COMMAND_IDS[name]])


class SimBLELink(SimLink):
    """The simulated flight over Bluetooth: everything, while the rocket is near."""

    name = "sim-ble"

    def _heard(self, state: FlightState) -> bool:
        in_range = state.altitude <= BLE_RANGE_M
        if in_range != self._connected:
            log.info("simulated BLE %s", "back in range" if in_range else "out of range")
        self._connected = in_range
        self._last_error = None if in_range else "rocket out of Bluetooth range (simulated)"
        return in_range

    async def send_command(self, name: str, args: dict[str, Any]) -> bytes:
        if name not in COMMANDS:
            raise UnknownCommand(f"simulator link has no command {name!r}")
        if not self._connected:
            raise LinkError("rocket out of Bluetooth range (simulated)")
        return await super().send_command(name, args)


class SimLoRaLink(LoRaLink):
    """The simulated flight over LoRa: the packets radio_app would report, put
    through the real link's conversion, so only the radio is made up."""

    name = "sim-lora"

    def __init__(self, on_packet: PacketHandler) -> None:
        super().__init__(on_packet)
        self._t0 = _flight_start()
        self._number = 0

    async def _run(self) -> None:
        self._radio_app = True
        self._on_state({"state": "receive", "connected": True})
        while True:
            for frame in self._frames(self._packet(time.monotonic())):
                await self._emit(frame.to_bytes())
            await asyncio.sleep(1.0 / LORA_PACKET_HZ)

    def _packet(self, now: float) -> dict[str, Any]:
        """The data line radio_app would write for a packet sent at ``now``."""
        t = (now - self._t0) % FLIGHT_CYCLE_S
        state = flight_state(t)
        altitude = PAD_ALTITUDE_M + state.altitude + random.uniform(-0.3, 0.3)
        lat, lon = _offset(PAD_LAT, PAD_LON, north_m=state.drift_m * 0.3, east_m=state.drift_m)
        self._number = (self._number + 1) % 256
        return {
            "type": "data",
            "id": LORA_FC_ID,
            "number": self._number,
            "tx_time_ms": int((now - self._t0) * 1000),
            "state": int(rocket_state(t)),
            "imu": {
                "altitude": _float16(altitude),
                "vspeed": _float16(state.speed),
                "attitude": _float16(state.sway * 25.0),
                "dt_ms": -LORA_AGE_MS["imu"],
            },
            "baro": {
                "p1": _float16(_pressure_hpa(altitude)),
                "p2": _float16(_pressure_hpa(altitude) + 0.3),
                "dt_ms": -LORA_AGE_MS["baro"],
            },
            "gps": {"latitude": lat, "longitude": lon, "dt_ms": -LORA_AGE_MS["gps"]},
            # Free-space loss with the distance to the rocket, and some fading.
            "rssi_dbm": round(
                -45.0
                - 20.0 * math.log10(max(10.0, math.hypot(state.altitude, state.drift_m)) / 10.0)
                + random.uniform(-2.0, 2.0),
                1,
            ),
            "median_bps": 2100.0 + random.uniform(-150.0, 150.0),
        }

    def status(self) -> dict[str, Any]:
        status = super().status()
        status.update({"simulated": True, "telemetry_socket": None, "command_socket": None})
        return status

    async def send_command(self, name: str, args: dict[str, Any]) -> bytes:
        if name not in ROCKET_COMMANDS:
            raise UnknownCommand(f"simulator link has no command {name!r}")
        line = self._encode_command(name, args)
        log.info("simulator received command %s over LoRa", name)
        return line
