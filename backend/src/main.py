#!/usr/bin/env python3
"""Entrypoint for the StarPi ground station backend.

    python src/main.py

Modules import each other flat (``from config import config``), so ``src`` must
be on ``sys.path`` — running this file directly takes care of that.
"""

from __future__ import annotations

import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn  # noqa: E402

from api import create_app  # noqa: E402
from config import config  # noqa: E402

app = create_app()


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("SP_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )

    log = logging.getLogger("starpi")
    log.info("links: %s", ", ".join(config.links) or "(none)")
    log.info("listening on http://%s:%d", config.host, config.port)

    uvicorn.run(app, host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    main()
