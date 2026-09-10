"""Build one sheet of every generated menu image, grouped by category."""
import json, io, sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "flow-out"
jobs = json.loads((ROOT / "tools" / "flow-jobs.json").read_text(encoding="utf-8"))

order, seen = [], set()
for j in jobs:
    if j["category"] not in seen:
        seen.add(j["category"]); order.append(j["category"])

cell, pad, lab, head = 150, 6, 16, 26
cols = 10
rows_meta = []
for cat in order:
    items = [j for j in jobs if j["category"] == cat and (SRC / f'{j["id"]}.png').exists()]
    if items:
        rows_meta.append((cat, items))

height = pad
for cat, items in rows_meta:
    height += head + ((len(items) + cols - 1)//cols) * (cell + lab + pad)
width = cols * (cell + pad) + pad

sheet = Image.new("RGB", (width, height), (247, 245, 242))
d = ImageDraw.Draw(sheet)
y = pad
for cat, items in rows_meta:
    d.text((pad, y + 6), f"{cat}  ({len(items)})", fill=(120, 20, 40))
    y += head
    for i, j in enumerate(items):
        r, c = divmod(i, cols)
        x = pad + c * (cell + pad)
        yy = y + r * (cell + lab + pad)
        im = Image.open(SRC / f'{j["id"]}.png').convert("RGB")
        w, h = im.size; side = min(w, h)
        im = im.crop(((w-side)//2, (h-side)//2, (w+side)//2, (h+side)//2)).resize((cell, cell), Image.LANCZOS)
        sheet.paste(im, (x, yy))
        d.text((x + 1, yy + cell + 2), j["name"][:22], fill=(30, 30, 30))
    y += ((len(items) + cols - 1)//cols) * (cell + lab + pad)

out = ROOT.parent / "menu-images-all.png"
sheet.save(out)
print(f"{sum(len(i) for _, i in rows_meta)} images -> {out}  {sheet.size}")
