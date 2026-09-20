"""Runtime configuration, sourced from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value else default


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Config:
    # --- HTTP server ---
    host: str = field(default_factory=lambda: _env_str("SP_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: _env_int("SP_PORT", 8000))

    # --- Storage ---
    db_path: str = field(default_factory=lambda: _env_str("SP_DB_PATH", "data/starpi.db"))

    # --- Link selection: which transports to bring up at startup ---
    links: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            part.strip()
            for part in _env_str("SP_LINKS", "ble").split(",")
            if part.strip()
        )
    )

    # --- BLE ---
    ble_device_name: str = field(
        default_factory=lambda: _env_str("SP_BLE_DEVICE_NAME", "John StarPi's Rocket")
    )
    # Optional: connect straight to a known MAC/UUID instead of scanning by name.
    ble_address: str | None = field(
        default_factory=lambda: os.environ.get("SP_BLE_ADDRESS") or None
    )
    ble_scan_timeout: float = field(
        default_factory=lambda: float(_env_int("SP_BLE_SCAN_TIMEOUT", 10))
    )
    ble_reconnect_delay: float = field(
        default_factory=lambda: float(_env_int("SP_BLE_RECONNECT_DELAY", 5))
    )

    # --- Behaviour ---
    # Maximum number of packets a single GET may return.
    max_page_size: int = field(default_factory=lambda: _env_int("SP_MAX_PAGE_SIZE", 1000))
    # Keep the newest N packets in memory for instant websocket backfill.
    live_buffer_size: int = field(default_factory=lambda: _env_int("SP_LIVE_BUFFER", 200))
    # Serve the bundled demo web page at "/". Off by default: the API is the
    # product, the page is a demo you opt into.
    serve_web: bool = field(default_factory=lambda: _env_bool("SP_SERVE_WEB", False))


config = Config()
