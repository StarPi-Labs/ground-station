"""Link registry.

Adding a transport (LoRa, say) means writing a :class:`~links.base.Link`
subclass and registering it here — nothing else in the backend changes.
"""

from __future__ import annotations

from typing import Callable

from links.base import CommandSpec, Link, LinkError, PacketHandler, UnknownCommand

LinkFactory = Callable[[PacketHandler], Link]


def _ble(on_packet: PacketHandler) -> Link:
    from links.ble import BLELink  # imported lazily: bleak needs a DBus/BlueZ stack

    return BLELink(on_packet)


def _sim(on_packet: PacketHandler) -> Link:
    from links.sim import SimLink

    return SimLink(on_packet)


REGISTRY: dict[str, LinkFactory] = {
    "ble": _ble,
    "sim": _sim,
    # "lora": _lora,  # future
}


def create_link(name: str, on_packet: PacketHandler) -> Link:
    try:
        factory = REGISTRY[name]
    except KeyError:
        known = ", ".join(sorted(REGISTRY))
        raise LinkError(f"unknown link {name!r}; known links: {known}") from None
    return factory(on_packet)


__all__ = [
    "CommandSpec",
    "Link",
    "LinkError",
    "PacketHandler",
    "UnknownCommand",
    "REGISTRY",
    "create_link",
]
