"""Transport-agnostic link interface.

A *link* is one physical path to the rocket: Bluetooth LE or LoRa today, so
nothing above this layer may assume either. A link only moves bytes: framing
and decoding live in :mod:`protocol`.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

# Called by a link for every received frame: (link_name, raw_frame).
PacketHandler = Callable[[str, bytes], Awaitable[None]]


class LinkError(RuntimeError):
    """Raised when a link exists but cannot deliver — the rocket is unreachable.

    The two subclasses below mean the *request* was wrong rather than the link,
    so the API answers them with a 4xx instead of a 503. Catch them before the
    base class.
    """


class UnknownCommand(LinkError):
    """Raised when a command name is not supported by a link."""


class UnknownLink(LinkError):
    """Raised when a caller names a link that is not configured."""


class BadCommand(LinkError):
    """Raised when a command's arguments are missing or malformed."""


@dataclass(frozen=True)
class CommandSpec:
    """Describes a command a link accepts, for discovery via ``GET /api/commands/available``."""

    name: str
    description: str
    params: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "params": self.params}


# Every command the rocket takes, with its id: one byte on the wire, the same
# on every link. Mirrors ``enum LoRaCommand`` in the firmware's ``lora.h``
# (0 is ``CMD_NONE``), which is where a new command has to be added first.
COMMAND_IDS = {
    "eject_a": 0x01,
    "eject_c": 0x02,
    "cut_main": 0x03,
    "cameras_on": 0x04,
    "cameras_off": 0x05,
    "sensor_calibration": 0x06,
    "system_arm": 0x07,
    "system_disarm": 0x08,
    "set_ground_temp": 0x09,
}

# Commands that carry an argument in the LoRa command packet's 64-bit ``data``.
# BLE writes the id byte alone, so only LoRa can send them.
DATA_COMMANDS = {"set_ground_temp"}

#: Accepted ground temperatures for ``set_ground_temp``, whole °C. The firmware
#: reads ``data`` as an unsigned integer: no negative values, no decimals.
GROUND_TEMP_RANGE_C = (0, 60)

#: What each of them does, for the links that offer them.
ROCKET_COMMANDS = {
    spec.name: spec
    for spec in (
        CommandSpec("eject_a", "Fire ejection charge A."),
        CommandSpec("eject_c", "Fire ejection charge C."),
        CommandSpec("cut_main", "Fire the main parachute cutter."),
        CommandSpec("cameras_on", "Turn the on-board cameras on."),
        CommandSpec("cameras_off", "Turn the on-board cameras off."),
        CommandSpec(
            "sensor_calibration",
            "Calibrate the IMU and barometers (about 10 s with both stopped; refused unless the rocket is idle).",
        ),
        CommandSpec("system_arm", "Arm the system: the rocket detects liftoff and runs its flight states."),
        CommandSpec("system_disarm", "Disarm the system: the rocket stays idle (no effect after liftoff)."),
        CommandSpec(
            "set_ground_temp",
            "Set the ground temperature the rocket uses (LoRa only).",
            {"celsius": f"whole degrees Celsius, {GROUND_TEMP_RANGE_C[0]} to {GROUND_TEMP_RANGE_C[1]}"},
        ),
    )
}
assert ROCKET_COMMANDS.keys() == COMMAND_IDS.keys()


def command_data(name: str, args: dict[str, Any]) -> int:
    """The LoRa command packet's 64-bit ``data`` for ``name`` with ``args``."""
    if name == "set_ground_temp":
        celsius = args.get("celsius")
        low, high = GROUND_TEMP_RANGE_C
        if isinstance(celsius, bool) or not isinstance(celsius, int) or not low <= celsius <= high:
            raise BadCommand(f"'celsius' must be a whole number from {low} to {high}, got {celsius!r}")
        return celsius
    # No other command uses it: optional, 0 by default.
    data = args.get("data", 0)
    if isinstance(data, bool) or not isinstance(data, int) or not 0 <= data < 1 << 64:
        raise BadCommand(f"'data' must be an integer from 0 to 2^64-1, got {data!r}")
    return data


class Link(abc.ABC):
    """Base class for a bidirectional link to the rocket."""

    #: Stable identifier, stored with every packet ("ble", "lora", ...).
    name: str = "link"

    def __init__(self, on_packet: PacketHandler) -> None:
        self._on_packet = on_packet
        self._connected = False
        self._last_error: str | None = None

    # --- lifecycle ---------------------------------------------------------

    @abc.abstractmethod
    async def start(self) -> None:
        """Begin connecting. Must return promptly; reconnection runs in the background."""

    @abc.abstractmethod
    async def stop(self) -> None:
        """Tear down the link and release the hardware."""

    # --- traffic -----------------------------------------------------------

    @abc.abstractmethod
    async def send_command(self, name: str, args: dict[str, Any]) -> bytes:
        """Send a command; returns the raw bytes put on the wire.

        Every implementation must validate before it transmits: raise
        :class:`UnknownCommand` for a name outside :meth:`supported_commands`,
        :class:`BadCommand` for arguments it will not accept, and
        :class:`LinkError` when the command is valid but cannot be delivered.
        Returning normally means the bytes really went out (on LoRa: were
        handed to the program that drives the radio).
        """

    @abc.abstractmethod
    def supported_commands(self) -> list[CommandSpec]:
        """Commands this link accepts."""

    # --- introspection -----------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._connected

    def status(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "connected": self._connected,
            "last_error": self._last_error,
        }

    def note_error(self, message: str | None) -> None:
        """Record a failure for ``GET /api/links`` to report."""
        self._last_error = message

    async def _emit(self, frame: bytes) -> None:
        await self._on_packet(self.name, frame)
