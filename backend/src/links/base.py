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
    """Raised when a link cannot carry out a request."""


class UnknownCommand(LinkError):
    """Raised when a command name is not supported by a link."""


@dataclass(frozen=True)
class CommandSpec:
    """Describes a command a link accepts, for discovery via ``GET /api/commands/available``."""

    name: str
    description: str
    params: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "params": self.params}


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

        Raises :class:`UnknownCommand` for an unsupported name, and
        :class:`LinkError` when the link cannot deliver it.
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
