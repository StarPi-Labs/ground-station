#!/usr/bin/env python3
"""Download the offline map of a launch site into openmct/tiles/.

The Pi has no internet at the field, so the Launch Control map is baked into
the frontend image: run this on a machine online (`make tiles`), then build
or deploy as usual. What it writes:

  map.pmtiles       OpenStreetMap vector tiles (Protomaps daily build), cut to
                    the area with the pmtiles CLI (run from its Docker image)
  fonts/, sprites/  label glyphs and icons for the Protomaps dark style
  satellite/        raster tiles {z}/{x}/{y}.jpg, from SAT_URL
  site.json         what the frontend reads: centre, bounds, layers, credits
  LICENSES.md       the licence of each of the above, with the fonts' and
                    icons' licence texts next to them

Protomaps allows extracting from its builds; the default satellite source
(EOX Sentinel-2 cloudless) is CC BY-NC-SA 4.0, 10 m per pixel. Point SAT_URL
at a sharper source you are allowed to store (a national orthophoto) for
more detail. SAT_URL= (empty) skips satellite.

Usage: fetch-tiles.py LAT LON [RADIUS_KM]
Env:   MAP_MAXZOOM (15), SAT_URL, SAT_MINZOOM (10), SAT_MAXZOOM (14),
       SAT_ATTRIBUTION (HTML, shown on the map), SAT_LICENSE, PMTILES_IMAGE
"""

import json
import math
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "openmct" / "tiles"
BUILDS = "https://build-metadata.protomaps.dev/builds.json"
BUILD_URL = "https://build.protomaps.com/{key}"
ASSETS = "https://protomaps.github.io/basemaps-assets"
FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"]
# Latin, Greek, Cyrillic and general punctuation; other scripts render without labels.
GLYPH_RANGES = [0, 256, 512, 768, 1024, 8192]
SPRITE = "dark"

MAP_MAXZOOM = int(os.environ.get("MAP_MAXZOOM", "15"))
SAT_URL = os.environ.get(
    "SAT_URL",
    "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg",
)
SAT_MINZOOM = int(os.environ.get("SAT_MINZOOM", "10"))
SAT_MAXZOOM = int(os.environ.get("SAT_MAXZOOM", "14"))
SAT_ATTRIBUTION = os.environ.get(
    "SAT_ATTRIBUTION",
    '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH'
    " (contains modified Copernicus Sentinel data 2024)",
)
SAT_LICENSE = os.environ.get(
    "SAT_LICENSE",
    "CC BY-NC-SA 4.0, https://creativecommons.org/licenses/by-nc-sa/4.0/ (non-commercial use only)",
)
MAP_ATTRIBUTION = (
    '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>,'
    ' <a href="https://protomaps.com">Protomaps</a>'
)
FONT_LICENSE = f"{ASSETS}/fonts/OFL.txt"
ICON_LICENSE = "https://raw.githubusercontent.com/tangrams/icons/master/LICENSE.md"

PMTILES_IMAGE = os.environ.get("PMTILES_IMAGE", "protomaps/go-pmtiles:v1.31.2")
USER_AGENT = "StarPi-ground-station/1 (offline launch site map)"


def get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def bbox(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    dlat = radius_km * 1000 / 111_320
    dlon = dlat / math.cos(math.radians(lat))
    return lon - dlon, lat - dlat, lon + dlon, lat + dlat


def tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2**z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return min(x, n - 1), min(y, n - 1)


def fetch_map(box: tuple[float, float, float, float]) -> str:
    builds = json.loads(get(BUILDS))
    key = builds[-1]["key"]
    print(f"map: extracting {key} to zoom {MAP_MAXZOOM} (only the area's tiles are downloaded)")
    subprocess.run(
        [
            "docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
            "-v", f"{OUT}:/out", PMTILES_IMAGE, "extract", BUILD_URL.format(key=key), "/out/map.pmtiles",
            "--bbox=" + ",".join(f"{v:.6f}" for v in box), f"--maxzoom={MAP_MAXZOOM}",
        ],
        check=True,
    )
    return key.removesuffix(".pmtiles")


def fetch_assets() -> None:
    jobs = []
    for font in FONTS:
        for start in GLYPH_RANGES:
            name = f"{start}-{start + 255}.pbf"
            jobs.append((f"{ASSETS}/fonts/{urllib.parse.quote(font)}/{name}", OUT / "fonts" / font / name))
    for suffix in ("", "@2x"):
        for ext in ("json", "png"):
            name = f"{SPRITE}{suffix}.{ext}"
            jobs.append((f"{ASSETS}/sprites/v4/{name}", OUT / "sprites" / name))
    jobs.append((FONT_LICENSE, OUT / "fonts" / "OFL.txt"))
    jobs.append((ICON_LICENSE, OUT / "sprites" / "LICENSE.md"))
    print(f"map: {len(jobs)} font and icon files")
    download(jobs)


def fetch_satellite(box: tuple[float, float, float, float]) -> int:
    west, south, east, north = box
    jobs = []
    for z in range(SAT_MINZOOM, SAT_MAXZOOM + 1):
        x0, y0 = tile(west, north, z)
        x1, y1 = tile(east, south, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                url = SAT_URL.format(z=z, x=x, y=y)
                jobs.append((url, OUT / "satellite" / str(z) / str(x) / f"{y}.jpg"))
    print(f"satellite: {len(jobs)} tiles, zoom {SAT_MINZOOM}-{SAT_MAXZOOM}")
    download(jobs)
    return len(jobs)


def download(jobs: list[tuple[str, Path]]) -> None:
    def one(job: tuple[str, Path]) -> None:
        url, path = job
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(get(url))

    # A few at a time: these are free services.
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(one, jobs))


def licenses(build: str) -> str:
    text = f"""# Offline map data

Downloaded by scripts/fetch-tiles.py. The map shows the required credits in
its corner.

- map.pmtiles: OpenStreetMap data, © OpenStreetMap contributors, under the
  Open Database License (ODbL) 1.0, https://www.openstreetmap.org/copyright.
  Extract of the Protomaps daily build {build}, https://protomaps.com.
  Tile schema adapted from Tilezen (MIT).
- fonts/: Noto Sans, © The Noto Project Authors, SIL Open Font License 1.1
  (fonts/OFL.txt). Glyphs from https://github.com/protomaps/basemaps-assets.
- sprites/: Protomaps basemap icons, derived from Mapzen's tangrams/icons,
  MIT (sprites/LICENSE.md).
"""
    if SAT_URL:
        text += f"""- satellite/: {re.sub(r"<[^>]+>", "", SAT_ATTRIBUTION)}.
  Licence: {SAT_LICENSE}. Source: {SAT_URL}
"""
    return text


def main() -> None:
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    lat, lon = float(sys.argv[1]), float(sys.argv[2])
    radius_km = float(sys.argv[3]) if len(sys.argv) == 4 else 5.0
    box = bbox(lat, lon, radius_km)

    # Start clean: tiles of a previous site must not linger in the image.
    for name in ("map.pmtiles", "fonts", "sprites", "satellite", "site.json", "LICENSES.md"):
        path = OUT / name
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
    OUT.mkdir(parents=True, exist_ok=True)

    build = fetch_map(box)
    fetch_assets()
    satellite = None
    if SAT_URL:
        fetch_satellite(box)
        satellite = {
            "tiles": "satellite/{z}/{x}/{y}.jpg",
            "minzoom": SAT_MINZOOM,
            "maxzoom": SAT_MAXZOOM,
            "attribution": SAT_ATTRIBUTION,
        }

    site = {
        "center": [lon, lat],
        "radius_km": radius_km,
        "bounds": list(box),
        "map": {
            "url": "map.pmtiles",
            "build": build,
            "glyphs": "fonts/{fontstack}/{range}.pbf",
            "sprite": f"sprites/{SPRITE}",
            "attribution": MAP_ATTRIBUTION,
        },
        "satellite": satellite,
    }
    (OUT / "site.json").write_text(json.dumps(site, indent=2) + "\n")
    (OUT / "LICENSES.md").write_text(licenses(build))
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"done: {OUT} ({size / 1e6:.1f} MB). Rebuild the frontend image to include it.")


if __name__ == "__main__":
    main()
