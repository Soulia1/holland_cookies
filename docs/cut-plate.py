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
    # Edge contrast, not detail. The hero renders this larger than 750px on a
    # retina display, so something is going to upscale it; sharpening the source
    # first is what survives that.
    out = out.filter(ImageFilter.UnsharpMask(radius=1.4, percent=52, threshold=3))
    # Unsharp touches the alpha channel too, which frays the circle. Restore it.
    out.putalpha(mask)
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

    one = cut(source)
    one.save(OUT.with_suffix(".png"), optimize=True)
    one.save(OUT.with_suffix(".webp"), quality=92, method=6)
    one.save(OUT.with_suffix(".avif"), quality=68)

    two = one.resize((one.width * 2, one.height * 2), Image.LANCZOS)
    alpha = two.getchannel("A")
    two = two.filter(ImageFilter.UnsharpMask(radius=2.2, percent=42, threshold=3))
    two.putalpha(alpha)
    retina = OUT.with_name(OUT.name + "@2x")
    two.save(retina.with_suffix(".webp"), quality=88, method=6)
    two.save(retina.with_suffix(".avif"), quality=62)

    for path in sorted(OUT.parent.glob("cookie-plate*")):
        print(f"{path.name:26} {path.stat().st_size / 1024:8.1f} KB")


if __name__ == "__main__":
    main()
