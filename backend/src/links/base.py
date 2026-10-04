"""Transport-agnostic link interface.

A *link* is one physical path to the rocket. Today that is Bluetooth LE; LoRa
is expected to join it, so nothing above this layer may assume BLE. A link
only moves bytes: framing and decoding live in :mod:`protocol`.
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
}

#: What each of them does, for the links that offer them.
ROCKET_COMMANDS = {
    spec.name: spec
    for spec in (
        CommandSpec("eject_a", "Fire ejection charge A."),
        CommandSpec("eject_c", "Fire ejection charge C."),
        CommandSpec("cut_main", "Fire the main parachute cutter."),
        CommandSpec("cameras_on", "Turn the on-board cameras on."),
        CommandSpec("cameras_off", "Turn the on-board cameras off."),
        CommandSpec("sensor_calibration", "Trigger the on-board sensor calibration routine."),
    )
}
assert ROCKET_COMMANDS.keys() == COMMAND_IDS.keys()


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
        Returning normally means the bytes really went out.
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
