"""Cut the hero pan out of the product photograph.

    python docs/cut-plate.py            # writes public/img/cookie-plate.*
    python docs/cut-plate.py --check    # writes a preview with the circle drawn

Produces `cookie-plate.{avif,webp,png}` and `cookie-plate@2x.{avif,webp}` — a
circular, transparent-background cut-out of the pan for `src/sections/Hero.tsx`.

Why this is a script and not a one-off: the source photograph is a placeholder
(a Stitch AI render), so it *will* be replaced with real photography. When it is,
re-measure CENTRE/RADIUS against the new file with `--check` and re-run.

There is no 2x PNG on purpose. It comes out around 4MB, and the PNG exists only
as the last-resort fallback for a browser that understands neither AVIF nor
WebP — which is not a browser that wants a 4MB hero.

Requires Pillow with AVIF support (Pillow >= 11.3, or pillow-avif-plugin).
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "public" / "img" / "hero-main.jpg"
OUT = ROOT / "public" / "img" / "cookie-plate"

# Measured against the 1408x768 source with --check: the pan's outer rim, not
# the cookie inside it. The rim is specular metal, so a brightness threshold
# finds the highlights rather than the edge — this was read off the preview.
CENTRE = (702.0, 385.0)
RADIUS = 375.0

# The mask is drawn at 4x and downsampled. PIL's ellipse is hard-edged, and a
# hard edge on a 750px circle is a visible staircase once a browser scales it.
SUPERSAMPLE = 4
PAD = 6


def cut(source: Image.Image) -> Image.Image:
    cx, cy = CENTRE
    size = int(round((RADIUS + PAD) * 2))
    left, top = int(round(cx - RADIUS - PAD)), int(round(cy - RADIUS - PAD))
    crop = source.crop((left, top, left + size, top + size))

    mask = Image.new("L", (size * SUPERSAMPLE, size * SUPERSAMPLE), 0)
    ImageDraw.Draw(mask).ellipse(
        [
            PAD * SUPERSAMPLE,
            PAD * SUPERSAMPLE,
            (PAD + 2 * RADIUS) * SUPERSAMPLE,
            (PAD + 2 * RADIUS) * SUPERSAMPLE,
        ],
        fill=255,
    )
    mask = mask.resize((size, size), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.6))

    out = crop.convert("RGBA")
    out.putalpha(mask)
    return out, mask


def sharpen(image: Image.Image, mask: Image.Image, radius: float, percent: int) -> Image.Image:
    """Sharpen once, then put the clean circle edge back.

    Once is the operative word. The first version of this sharpened the 1x
    output and then sharpened the 2x it built *from* that output — two passes
    over the same edges, which is how you get the pale halo along a rim that
    reads as "over-processed" rather than "sharp". Both sizes are now derived
    from the same unsharpened cut and each gets a single pass tuned to its own
    scale.

    UnsharpMask works on the alpha channel too, which frays the circle into a
    ring of half-transparent pixels, so the mask is reapplied afterwards.
    """
    out = image.filter(ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=3))
    out.putalpha(mask if mask.size == out.size else mask.resize(out.size, Image.LANCZOS))
    return out


def check(source: Image.Image, path: Path) -> None:
    cx, cy = CENTRE
    preview = source.copy()
    draw = ImageDraw.Draw(preview)
    draw.ellipse(
        [cx - RADIUS, cy - RADIUS, cx + RADIUS, cy + RADIUS], outline=(255, 0, 255), width=4
    )
    draw.line([cx, 0, cx, preview.height], fill=(0, 255, 255), width=2)
    draw.line([0, cy, preview.width, cy], fill=(0, 255, 255), width=2)
    preview.save(path)
    print(f"wrote {path} — the magenta circle should sit on the pan's outer rim")


def main() -> None:
    source = Image.open(SOURCE).convert("RGB")

    if "--check" in sys.argv:
        check(source, ROOT / "cookie-plate-check.png")
        return

    clean, mask = cut(source)

    # 1x: a light pass. This rendition is only ever *downscaled* by the browser
    # (760px CSS against a 762px file at 1x), and downscaling is already sharp,
    # so anything heavier here is halo for no gain.
    one = sharpen(clean, mask, radius=1.2, percent=45)
    one.save(OUT.with_suffix(".png"), optimize=True)
    one.save(OUT.with_suffix(".webp"), quality=92, method=6)
    one.save(OUT.with_suffix(".avif"), quality=68)

    # 2x: upscale the *clean* cut, then one heavier pass. Lanczos is soft by
    # construction — that is the price of not ringing — and this puts back the
    # edge contrast it costs, at the scale the edges now live at.
    big = clean.resize((clean.width * 2, clean.height * 2), Image.LANCZOS)
    two = sharpen(big, mask, radius=2.0, percent=60)
    retina = OUT.with_name(OUT.name + "@2x")
    # Encoded a step above the 1x files. This is the rendition a retina display
    # actually gets, at as near 1:1 with its device pixels as this photograph
    # allows, so it is the one worth spending bytes on.
    two.save(retina.with_suffix(".webp"), quality=92, method=6)
    two.save(retina.with_suffix(".avif"), quality=72)

    for path in sorted(OUT.parent.glob("cookie-plate*")):
        print(f"{path.name:26} {path.stat().st_size / 1024:8.1f} KB")


if __name__ == "__main__":
    main()
