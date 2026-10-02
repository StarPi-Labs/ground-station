#!/usr/bin/env python3
"""Regenerates openmct/brand/assets/ from the team's source artwork.

Usage: python3 scripts/brand-assets.py PATCH.xcf NASALIZATION.otf

PATCH.xcf is the circular mission patch (StarPi_LogoCircular_HD.xcf); it
becomes the header logo, the favicons and the About image. NASALIZATION.otf
is the team's display typeface, which its licence lets us use for logos but
not ship as a font: the wordmarks are written as plain SVG outlines, and the
font file itself never enters the repository or the image.

Needs ImageMagick (`magick`) and fontTools (`pip install fonttools`).
"""

import pathlib
import subprocess
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

OUT = pathlib.Path(__file__).resolve().parent.parent / 'openmct' / 'brand' / 'assets'
PATCH_SIZES = {'patch-512.png': 512, 'patch-192.png': 192, 'patch-64.png': 64,
               'favicon-32.png': 32, 'favicon-16.png': 16}
WORDMARKS = {'wordmark.svg': 'STARPI', 'wordmark-ground-station.svg': 'GROUND STATION'}
# Extra space between letters, in font units: the brand sets its caps wide.
TRACKING = 60


def patch(source):
    for name, size in PATCH_SIZES.items():
        subprocess.run(['magick', source, '-background', 'none', '-flatten',
                        '-resize', f'{size}x{size}', '-strip', OUT / name], check=True)


def wordmark(font, text):
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    pen = SVGPathPen(glyphs)
    bounds = BoundsPen(glyphs)
    x = 0
    for char in text:
        name = cmap[ord(char)]
        # Font units grow upwards, SVG downwards: flip about the baseline.
        glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
        glyphs[name].draw(TransformPen(bounds, (1, 0, 0, -1, x, 0)))
        x += glyphs[name].width + TRACKING
    # Tight box around the ink, overshoots included.
    left, top, right, bottom = bounds.bounds

    return (f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="{left} {top} {right - left} {bottom - top}" '
            f'role="img" aria-label="{text}">\n'
            f'<path fill="currentColor" d="{pen.getCommands()}"/>\n</svg>\n')


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    OUT.mkdir(parents=True, exist_ok=True)
    patch(sys.argv[1])
    font = TTFont(sys.argv[2])
    for name, text in WORDMARKS.items():
        (OUT / name).write_text(wordmark(font, text))
    print(f'Wrote {OUT}')


if __name__ == '__main__':
    main()
