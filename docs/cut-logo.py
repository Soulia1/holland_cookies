"""Lift the Holland Cookies logo off its white card.

    python docs/cut-logo.py

Reads `public/img/logo.jpg` — a screenshot of the logo on a white card, complete
with rounded black corners and a faint leaf watermark — and writes
`public/img/logo.png` / `.webp`: the same artwork on transparency, trimmed.

The header sits over cream and the footer over burgundy, and a JPEG with a baked
white rectangle shows as a visible patch on both. The mark is the one thing on
the page that cannot look pasted on.

Three things make this more than a white-key:

1. **The leaf watermark has to go, not fade.** Its lines bottom out around
   luminance 205, which a naive key leaves as a 13%-opaque ghost. The alpha is
   pushed through a smoothstep whose toe sits above the watermark, so it is gone
   rather than faint.

2. **Unpremultiplying only where there is coverage.** Recovering the true colour
   of a pixel composited over white — `(c - 255(1-a)) / a` — is correct for the
   solid artwork and catastrophic for a light grey line, where it drives the
   result negative and the line renders *black*. That is exactly what the first
   attempt did to the watermark. So the recovered colour is blended back toward
   the original as coverage falls.

3. **The card's rounded corners are content too.** A plain bounding box keeps
   them, so the border band is cleared before the trim rather than after.
"""

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "public" / "img" / "logo.jpg"
OUT = ROOT / "public" / "img" / "logo"

# Coverage below TOE is nothing, above KNEE is solid. TOE sits above the
# watermark (~0.20 coverage) and well below the "Cookies" grey (~0.58).
TOE, KNEE = 0.23, 0.38
# The source card's black rounded corners live within this many pixels of the
# edge. Cleared before trimming, or the trim keeps them.
FRAME = 14
# Breathing room left around the artwork so a CSS filter or shadow has somewhere
# to fall without being clipped by the bitmap edge.
MARGIN = 6


def smoothstep(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    t = np.clip((x - lo) / (hi - lo), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def main() -> None:
    source = np.asarray(Image.open(SOURCE).convert("RGB")).astype(np.float64)

    # Coverage: how far this pixel is from the white it was composited onto.
    # The darkest channel, not luminance — a saturated red on white is dark in
    # green and blue while staying bright overall, and luminance would read it
    # as half-transparent.
    coverage = (255.0 - source.min(axis=2)) / 255.0
    alpha = smoothstep(coverage, TOE, KNEE)

    with np.errstate(divide="ignore", invalid="ignore"):
        recovered = (source - 255.0 * (1.0 - coverage[..., None])) / np.maximum(
            coverage[..., None], 1e-6
        )
    # Trust the recovered colour where there is real coverage; fall back to the
    # pixel as photographed where there is not.
    trust = smoothstep(coverage, 0.35, 0.75)[..., None]
    colour = np.clip(recovered * trust + source * (1.0 - trust), 0, 255)

    alpha[:FRAME, :] = 0
    alpha[-FRAME:, :] = 0
    alpha[:, :FRAME] = 0
    alpha[:, -FRAME:] = 0

    rgba = Image.fromarray(
        np.dstack([colour, alpha * 255.0]).astype(np.uint8), "RGBA"
    )

    ys, xs = np.nonzero(alpha > 0.08)
    box = (
        max(int(xs.min()) - MARGIN, 0),
        max(int(ys.min()) - MARGIN, 0),
        min(int(xs.max()) + 1 + MARGIN, rgba.width),
        min(int(ys.max()) + 1 + MARGIN, rgba.height),
    )
    rgba = rgba.crop(box)

    rgba.save(OUT.with_suffix(".png"), optimize=True)
    rgba.save(OUT.with_suffix(".webp"), quality=94, method=6, lossless=False)
    print(f"trimmed to {rgba.size} from box {box}")
    for path in (OUT.with_suffix(".png"), OUT.with_suffix(".webp")):
        print(f"{path.name:16} {path.stat().st_size / 1024:7.1f} KB")


if __name__ == "__main__":
    main()
