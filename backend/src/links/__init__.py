"""Link registry.

Adding a transport means writing a :class:`~links.base.Link`
subclass and registering it here — nothing else in the backend changes.
"""

from __future__ import annotations

from typing import Callable

from links.base import (
    BadCommand,
    CommandSpec,
    Link,
    LinkError,
    PacketHandler,
    UnknownCommand,
    UnknownLink,
)

LinkFactory = Callable[[PacketHandler], Link]


def _ble(on_packet: PacketHandler) -> Link:
    from links.ble import BLELink  # imported lazily: bleak needs a DBus/BlueZ stack

    return BLELink(on_packet)


def _sim(on_packet: PacketHandler) -> Link:
    from config import config
    from links.sim import SimLink

    return SimLink(on_packet, rate=config.sim_rate)


def _sim_ble(on_packet: PacketHandler) -> Link:
    from config import config
    from links.sim import SimBLELink

    return SimBLELink(on_packet, rate=config.sim_rate)


def _sim_lora(on_packet: PacketHandler) -> Link:
    from links.sim import SimLoRaLink

    return SimLoRaLink(on_packet)


def _lora(on_packet: PacketHandler) -> Link:
    from links.lora import LoRaLink

    return LoRaLink(on_packet)


REGISTRY: dict[str, LinkFactory] = {
    "ble": _ble,
    "lora": _lora,
    "sim": _sim,
    # The same simulated flight over two radios, one of them dropping out.
    "sim-ble": _sim_ble,
    "sim-lora": _sim_lora,
}


def create_link(name: str, on_packet: PacketHandler) -> Link:
    try:
        factory = REGISTRY[name]
    except KeyError:
        known = ", ".join(sorted(REGISTRY))
        raise UnknownLink(f"unknown link {name!r}; known links: {known}") from None
    return factory(on_packet)


__all__ = [
    "BadCommand",
    "CommandSpec",
    "Link",
    "LinkError",
    "PacketHandler",
    "UnknownCommand",
    "UnknownLink",
    "REGISTRY",
    "create_link",
]
