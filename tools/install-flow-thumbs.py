"""
Turn the generated Flow images into menu thumbnails, and write the image map.

`build-flow-jobs.py` names every job after the menu item it belongs to, and
`flow-batch.mjs` writes each result as `<item id>.png`, so the mapping this
script needs already exists in the filenames — nothing here has to guess which
picture belongs to which product.

Two things happen to each file:

**A square crop.** Flow returns 16:9 whatever ratio is asked for (the ratio
control is one of the pieces of UI the packaged server can no longer find), and
the menu shows squares. Every prompt says "centred in frame", so a centre crop
is the right one — but it is the centre of the *short* side, which keeps the
full height of the subject and trims the empty marble at either end.

**The same downscale and sharpen the shop photographs get**, from
`build-menu-thumbs.py`, so a generated row and a photographed row do not sit
next to each other at visibly different levels of sharpness.

The generated files are written alongside the photographed ones and the map is
rebuilt to prefer a photograph where one exists: a real picture of the real
product beats a plausible picture of it, every time.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
GENERATED = ROOT / "tools" / "flow-out"
OUT = ROOT / "public" / "img" / "menu" / "ai"
MAP_TS = ROOT / "src" / "data" / "menuImages.ts"
JOBS = ROOT / "tools" / "flow-jobs.json"

SIZE = 320


def square(im: Image.Image) -> Image.Image:
    w, h = im.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return im.crop((left, top, left + side, top + side))


def finish(im: Image.Image) -> Image.Image:
    im = im.resize((SIZE, SIZE), Image.LANCZOS)
    return im.filter(ImageFilter.UnsharpMask(radius=1.4, percent=80, threshold=3))


def photographed_ids() -> set[str]:
    """
    Item ids that already have a real photograph, read from the map itself.

    Reads `PHOTOGRAPHED`, not `MENU_IMAGES`. The latter is now built by spreading
    two objects together and contains no id literals at all, so parsing it
    returned the empty set — and an empty set means *every* generated file is
    treated as unclaimed, which would have written a generated entry over each
    of the nineteen real photographs. Silently, and looking like success.
    """
    src = MAP_TS.read_text(encoding="utf-8")
    body = src.split("const PHOTOGRAPHED", 1)[1].split("};", 1)[0]
    found = set(re.findall(r'"([a-z0-9-]+)":\s*`\$\{BASE\}/', body))
    if not found:
        raise SystemExit("parsed no photographed ids — refusing to overwrite the map")
    return found


def main() -> int:
    if not GENERATED.is_dir():
        print(f"no generated images at {GENERATED}", file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    jobs = {j["id"]: j for j in json.loads(JOBS.read_text(encoding="utf-8"))}
    have_photo = photographed_ids()

    written: list[str] = []
    for path in sorted(GENERATED.glob("*.png")):
        item_id = path.stem
        if item_id not in jobs:
            print(f"  skip {item_id}: not a menu item", file=sys.stderr)
            continue
        with Image.open(path) as raw:
            finish(square(raw.convert("RGB"))).save(
                OUT / f"{item_id}.webp", "WEBP", quality=88, method=6
            )
        written.append(item_id)

    print(f"{len(written)} generated thumbnails -> {OUT.relative_to(ROOT)}")
    only_generated = [i for i in written if i not in have_photo]
    print(f"  {len(have_photo)} items keep their real photograph")
    print(f"  {len(only_generated)} items use the generated one")

    # Written straight into the map, between the two markers that exist for it.
    # Only that region is replaced, so every hand-authored line in the file —
    # the photographs, the comments, the precedence rule — survives a rerun.
    lines = [f'  "{i}": "/img/menu/ai/{i}.webp",' for i in sorted(only_generated)]
    src = MAP_TS.read_text(encoding="utf-8")
    start, end = "/* GENERATED-START */", "/* GENERATED-END */"
    if start not in src or end not in src:
        print("markers missing from menuImages.ts", file=sys.stderr)
        return 1
    head = src.split(start)[0] + start + "\n"
    tail = "  " + end + src.split(end, 1)[1]
    MAP_TS.write_text(head + "\n".join(lines) + "\n" + tail, encoding="utf-8")
    print(f"  map updated -> {MAP_TS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
