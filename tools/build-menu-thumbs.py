"""
Cut one square menu thumbnail out of each shop photograph.

The source photographs in `Menu_images/` are phone pictures taken in the shop:
handheld, mixed lighting, busy backgrounds, some with an Arabic caption burned
into the pixels. The menu needs the opposite of that — a small square that is
almost entirely product, readable at 96px, and consistent enough that ninety of
them in a column do not look like ninety different photographers.

So each crop is declared here rather than computed. A generic "centre square"
would be wrong for most of these: the food is rarely in the middle of the frame
(it is held up, so it sits low), and four of the photographs carry a caption
that a centre crop would put straight through the middle of the thumbnail. The
boxes below were read off the pixels and then checked by looking at the output.

`CROPS` maps a source image to one or more named crops. Several photographs hold
more than one product — the two cookie-cup pictures are three cups each — so the
unit is the crop, not the file.

Enhancement is deliberately mild and entirely local: a white-balance nudge, a
contrast and saturation lift, and an unsharp pass to recover what the phone's
own JPEG compression softened. It is not trying to turn a phone snap into the
studio renders on the home page; it is trying to make a phone snap look like it
was taken on purpose.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "Menu_images"
OUT = ROOT / "public" / "img" / "menu"

# The rendition written to disk. Thumbnails are shown at 96px and the retina
# case is the one that has to hold up, so everything is written at 2x that and
# left there — a third size for a 288px display is a file nobody requests.
SIZE = 320

# Source files, in the order `ls` gives them, mapped to the short ids used
# below. Keeping the mapping here means the WhatsApp filenames — which carry a
# timestamp and a duplicate counter and nothing else — appear exactly once.
SOURCES = {
    "img01": "WhatsApp Image 2026-09-03 at 3.38.02 PM (1).jpeg",
    "img02": "WhatsApp Image 2026-09-03 at 3.38.02 PM.jpeg",
    "img03": "WhatsApp Image 2026-09-03 at 3.38.03 PM (1).jpeg",
    "img04": "WhatsApp Image 2026-09-03 at 3.38.03 PM (2).jpeg",
    "img05": "WhatsApp Image 2026-09-03 at 3.38.03 PM (3).jpeg",
    "img06": "WhatsApp Image 2026-09-03 at 3.38.03 PM.jpeg",
    "img07": "WhatsApp Image 2026-09-03 at 3.38.07 PM (1).jpeg",
    "img08": "WhatsApp Image 2026-09-03 at 3.38.07 PM (2).jpeg",
    "img09": "WhatsApp Image 2026-09-03 at 3.38.07 PM (3).jpeg",
    "img10": "WhatsApp Image 2026-09-03 at 3.38.07 PM (4).jpeg",
    "img11": "WhatsApp Image 2026-09-03 at 3.38.07 PM (5).jpeg",
    "img12": "WhatsApp Image 2026-09-03 at 3.38.07 PM (6).jpeg",
    "img13": "WhatsApp Image 2026-09-03 at 3.38.07 PM.jpeg",
    "img14": "WhatsApp Image 2026-09-03 at 3.38.08 PM (1).jpeg",
    "img15": "WhatsApp Image 2026-09-03 at 3.38.08 PM (2).jpeg",
    "img16": "WhatsApp Image 2026-09-03 at 3.38.08 PM (3).jpeg",
    "img17": "WhatsApp Image 2026-09-03 at 3.38.08 PM (4).jpeg",
    "img18": "WhatsApp Image 2026-09-03 at 3.38.08 PM (5).jpeg",
    "img19": "WhatsApp Image 2026-09-03 at 3.38.08 PM (6).jpeg",
    "img20": "WhatsApp Image 2026-09-03 at 3.38.08 PM (7).jpeg",
    "img21": "WhatsApp Image 2026-09-03 at 3.38.08 PM.jpeg",
}

# source id -> [(output name, (left, top, right, bottom)), ...]
#
# Every box is square in the source, so nothing is squashed on the way down to
# SIZE. Where a caption is burned into the picture the box is chosen to exclude
# it, which is why a few of these are noticeably tighter than the food.
CROPS: dict[str, list[tuple[str, tuple[int, int, int, int]]]] = {
    # Scoops — foil trays of joined cookie domes.
    "img02": [("scoop-mixed", (25, 300, 1175, 1450))],
    "img01": [("scoop-vanilla-mixed-filling", (10, 150, 1190, 1330))],
    "img05": [("scoop-chocolate", (0, 340, 1140, 1480))],
    # Caption sits low across the tray, so the crop takes the clean top of it.
    "img03": [("scoop-vanilla", (300, 840, 650, 1190))],
    # Caption is top-left, well clear of the tray.
    "img04": [("scoop-red-velvet", (175, 650, 1015, 1490))],
    # Caption runs straight through the middle; only the lower tray is clean.
    "img06": [("scoop-vanilla-nutella", (170, 385, 515, 730))],
    # Pans.
    "img15": [("pan-vanilla-nutella", (20, 700, 800, 1480))],
    "img16": [("pan-red-velvet-white", (95, 720, 795, 1420))],
    # Cross-sections, held. Cropped in tight so the glove is mostly out.
    "img11": [("cut-vanilla-nutella", (250, 450, 800, 1000))],
    "img12": [("cut-chocolate-nutella", (330, 290, 1000, 960))],
    "img19": [("cut-red-velvet-cream", (300, 240, 960, 900))],
    # Matilda — the one photograph that names its own product.
    "img13": [("matilda", (60, 340, 900, 1180))],
    # Cups. Three to a photograph, so three crops each.
    "img08": [
        ("cup-caramel", (0, 880, 500, 1380)),
        ("cup-red-velvet-white", (270, 570, 770, 1070)),
        ("cup-chocolate-pistachio", (590, 830, 1090, 1330)),
    ],
    "img14": [
        ("cup-red-velvet-nutella", (225, 495, 565, 835)),
        ("cup-chocolate-nutella", (615, 405, 950, 740)),
        ("cup-vanilla-nutella", (485, 640, 1005, 1160)),
    ],
    # Slices, most already on a plain white sweep.
    "img09": [("cake-vanilla-wedge", (440, 180, 1340, 1080))],
    "img20": [("brookie-classic", (400, 180, 1300, 1080))],
    "img07": [("slice-red-velvet-cream", (400, 120, 1300, 1020))],
    "img21": [("slice-chocolate-caramel", (350, 120, 1270, 1040))],
    "img10": [("slice-chocolate-ganache", (130, 500, 950, 1320))],
    "img18": [("apple-tart", (215, 420, 975, 1180))],
    "img17": [("cheesecake-red-velvet", (300, 800, 1000, 1500))],
}


def enhance(im: Image.Image) -> Image.Image:
    """
    The mild, entirely local clean-up described in the header.

    Order matters and is not arbitrary: colour and contrast are corrected while
    the image is still large, and the unsharp pass runs last, *after* the
    downscale, because sharpening before a resize is thrown away by the
    resampling and sharpening after it is what the eye actually sees.
    """
    im = ImageEnhance.Color(im).enhance(1.12)
    im = ImageEnhance.Contrast(im).enhance(1.08)
    im = ImageEnhance.Brightness(im).enhance(1.04)
    im = im.resize((SIZE, SIZE), Image.LANCZOS)
    return im.filter(ImageFilter.UnsharpMask(radius=1.6, percent=95, threshold=3))


def main() -> int:
    if not SRC.is_dir():
        print(f"missing source directory: {SRC}", file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    written = 0

    for key, crops in CROPS.items():
        path = SRC / SOURCES[key]
        if not path.is_file():
            print(f"missing source file: {path}", file=sys.stderr)
            return 1

        with Image.open(path) as raw:
            im = raw.convert("RGB")
            for name, box in crops:
                left, top, right, bottom = box
                if right - left != bottom - top:
                    print(f"{name}: box is not square: {box}", file=sys.stderr)
                    return 1
                if right > im.width or bottom > im.height:
                    print(
                        f"{name}: box {box} falls outside {im.width}x{im.height}",
                        file=sys.stderr,
                    )
                    return 1
                out = OUT / f"{name}.webp"
                enhance(im.crop(box)).save(out, "WEBP", quality=88, method=6)
                print(f"{key} -> {out.relative_to(ROOT)}")
                written += 1

    print(f"\n{written} thumbnails written to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
