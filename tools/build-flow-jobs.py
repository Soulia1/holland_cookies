"""
Turn the menu into one Google Flow prompt per item.

Two rules, and they are the same two the menu itself is held to.

**Faithful.** A prompt describes only what the printed item names. "Vanilla,
Nutella filling" becomes a vanilla cookie with a Nutella centre — not a cookie
"drizzled with salted caramel and finished with gold leaf", which would be
generating a picture of a product Holland does not sell. The vessel comes from
the category, because that is a fact about the format: scoops arrive in a foil
tray, cups in a paper liner, gateaux on a stand.

**One house style.** Every prompt ends with the same paragraph, lifted from what
the home page photographs actually are: directly overhead, white marble, soft
daylight, minimal props. Ninety pictures that each look good and none of which
look related is a worse outcome than ninety plainer ones that read as one shoot.
The negatives at the end are the ones that matter for a menu thumbnail — text
baked into the image, a logo, a hand, or a brand wrapper would each make the
picture unusable at 60px.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MENU_TS = ROOT / "src" / "data" / "menu.ts"
OUT = ROOT / "tools" / "flow-jobs.json"

# The house style, appended to every prompt. Derived from hero-main.jpg and
# pan-classic.jpg, which are the pictures the rest of the site is judged against.
STYLE = (
    "Photographed directly from above as a flat lay, centred in frame, "
    "on a pale white marble surface with soft natural window light from the left "
    "and gentle realistic shadows. Warm, appetising editorial food photography, "
    "true-to-life colour, crisp focus, fine crumb and texture detail, shallow "
    "depth of field. Minimal styling. "
    "No text, no writing, no lettering, no logos, no watermarks, no brand "
    "packaging, no hands, no people, no cutlery unless described."
)

# Drinks are the exception to the overhead rule, and it is not a stylistic
# preference. A tall glass photographed from directly above is a circle of cream
# and nothing else — the layers, the ice and the height, which are the whole
# reason a milkshake looks like a milkshake, are all in the vertical dimension
# that an overhead shot flattens away. So the four drink categories are shot
# from just above eye level instead, and keep every other element of the style.
DRINK_CATEGORIES = {"coffee", "iced-coffee", "frappes", "milkshakes"}

DRINK_STYLE = (
    "Photographed straight on at table height in a slight three-quarter view, "
    "centred in frame, on a pale white marble surface with soft natural window "
    "light from the left and gentle realistic shadows. Warm, appetising "
    "editorial drink photography, true-to-life colour, crisp focus, condensation "
    "and texture detail, softly blurred background. Minimal styling. "
    "No text, no writing, no lettering, no logos, no watermarks, no brand "
    "packaging, no hands, no people."
)

# The one deliberate exception to "no hands" in the whole house style. The
# shop's own Instagram photography for tagines is a cookie split open and
# held apart by gloved hands, and that is what was asked for here — a
# different, explicit style for one category rather than a stylistic drift
# the rest of the menu should follow.
TAGINE_STYLE = (
    "Photographed close-up at a slight downward angle, the cookie tagine "
    "pulled apart and held open by two hands wearing black food-service "
    "gloves to reveal a clean cross-section of the filling, a white ceramic "
    "plate visible beneath. Warm indoor bakery lighting, true-to-life "
    "colour, crisp focus on the filling with a softly blurred background, "
    "realistic and appetising, fresh-from-the-oven texture on the crust. "
    "No text, no writing, no lettering, no logos, no watermarks, no brand "
    "packaging, no visible faces."
)

# How each category presents its food. The vessel is part of the product.
VESSEL = {
    "plain-cookies": "a single thick round cookie resting on a small white ceramic plate",
    "cookie-pans": "a deep-dish cookie pie baked and served in a square aluminium foil pan",
    "cookie-cups": "a single cookie cup in a fluted paper liner, its hollow centre filled",
    "cookie-tagines": "a cookie tagine, split open down the middle and pulled apart by hand to reveal the filling inside",
    "cookie-scoops": "several joined cookie dough scoops baked together in a round aluminium foil tray",
    "cookie-cake": "a thick wedge of layered cookie cake on a white plate, cut face toward the camera",
    "brownies-brookies": "a thick square slice on a white plate, cut face toward the camera",
    "cookie-boxes": "an open white bakery box filled with cookies, seen from above",
    "tagines": "a dessert served in a small round dish",
    "molten-cakes": "a small round molten cake on a white plate, one spoonful opened to show the soft centre",
    "cheesecakes-tarts": "a triangular slice on a white plate, cut face toward the camera",
    "gateaux": "a whole round layered gateau on a white cake stand",
    "biscuits-kahk": "a pile of small biscuits in an open box, seen from above",
    "coffee": "a coffee in a white ceramic cup on a saucer",
    "iced-coffee": "an iced coffee in a tall clear glass with ice",
    "frappes": "a blended iced frappé in a tall clear glass, topped with cream",
    "milkshakes": "a thick milkshake in a tall clear glass, topped with cream",
}

# Flavour and filling words, expanded to what a camera would actually see.
LOOKS = {
    "vanilla": "pale golden vanilla dough studded with chocolate chips",
    "chocolate": "dark chocolate dough, deep brown, studded with chocolate chips",
    "red velvet": "deep crimson red velvet dough flecked with white chocolate",
    "pistachio": "pistachio green, with chopped pistachios",
    "lotus": "caramel-brown Lotus biscuit spread, glossy",
    "coffee": "coffee-brown dough",
    "nutella": "glossy hazelnut chocolate spread",
    "white nutella": "glossy white chocolate hazelnut spread, ivory coloured",
    "kinder bueno": "milk chocolate and hazelnut cream",
    "caramel": "glossy golden caramel",
    "kunafa": "shredded golden kunafa pastry on top",
    "raspberry": "raspberry red fruit topping",
    "blueberry": "blueberry purple fruit topping",
    "cream": "a thick layer of white cream",
    "smores": "toasted marshmallow and chocolate",
    "matilda": "a cookie shell filled with dark chocolate ganache and chocolate cake",
    "despacito": "layered chocolate dessert with a cream seam",
    "happiness": "a layered dessert in a round dish",
    "apple": "spiced apple filling under a golden lattice pastry crust",
    "cheesecake": "a pale baked cheesecake layer",
    "brownie": "a dense fudgy brownie layer",
    "brookie": "a brownie layer under a golden chocolate-chip cookie layer",
    "ghorayeba": "pale crumbly shortbread rounds",
    "petit fours": "small assorted iced petit four biscuits",
    "kahk": "round powdered-sugar dusted kahk biscuits",
    "biscuits": "plain golden biscuits",
    "mixed": "an assortment of different coloured cookie doughs side by side",
}

# Drinks get their own vocabulary rather than sharing the one above, because
# the two collide on real words. "Coffee" is a cookie flavour in this menu *and*
# a category of drink: searching one combined map made Turkish Coffee come out
# described as "coffee-brown dough". Two maps, and the category decides which
# one is consulted, is the fix — not a longer list of exceptions.
DRINK_LOOKS = {
    "cappuccino": "a cappuccino with a thick cap of microfoam and a leaf of latte art",
    "latte": "a latte, milky and pale, with latte art on the surface",
    "mocha": "a mocha, chocolate-dark under a swirl of cream",
    "cortado": "a cortado in a small glass, espresso cut with warm milk in even layers",
    "hot chocolate": "a deep brown hot chocolate topped with whipped cream",
    "flat white": "a flat white with a thin glossy layer of microfoam",
    "espresso": "a short dark espresso in a small cup with a hazelnut crema",
    "turkish": "a Turkish coffee in a small cup with thick foam, beside its copper pot",
    "french": "a tall milky French coffee in a glass",
    "macchiato": "an espresso marked with a single spoonful of white foam",
    "iced": "served cold in a tall glass over plenty of ice, beaded with condensation",
    "frappuccino": "a thick blended iced coffee topped with swirled whipped cream",
    "shake": "a thick blended milkshake topped with swirled whipped cream",
    "water": "a clear glass of still water",
    # Flavour, which for a drink is mostly colour. Without these every shake
    # came out the same beige glass whatever the menu called it.
    "vanilla": "pale cream coloured",
    "chocolate": "deep chocolate brown",
    "pistachio": "pistachio green, dusted with chopped pistachios",
    "lotus": "caramel-brown, dusted with crushed Lotus biscuit",
    "caramel": "golden caramel coloured, with a caramel drizzle",
    "classic": "classic coffee coloured",
}


def parse_menu() -> list[dict]:
    """
    Read ids, names, notes and category ids out of the TS literal.

    Indentation is the discriminator, and it is trustworthy because the repo
    runs prettier over this file: a *category* id sits at four spaces, an item
    at six (inline) or eight (when the literal wraps). Matching `id:` without
    regard to depth is what the first version of this did, and it read every
    item id as a new category — the categories it reported included
    "pan-red-velvet-white-nutella", which is a cookie, not a heading.
    """
    src = MENU_TS.read_text(encoding="utf-8")
    body = src.split("export const MENU:", 1)[1].split("/** Every id on the page", 1)[0]

    items: list[dict] = []
    category: str | None = None
    pending: dict | None = None

    for line in body.splitlines():
        cat = re.match(r'^ {4}id: "([a-z0-9-]+)",$', line)
        if cat:
            category = cat.group(1)
            pending = None
            continue

        # An item written on one line.
        inline = re.match(
            r'^ {6}\{ id: "([^"]+)", name: "([^"]+)", price: (\d+)'
            r'(?:, note: "([^"]+)")? \},$',
            line,
        )
        if inline and category:
            items.append(
                {
                    "id": inline.group(1),
                    "name": inline.group(2),
                    "category": category,
                    "note": inline.group(4),
                }
            )
            continue

        # An item whose literal wraps over several lines: collect the fields as
        # they go by and commit when the closing brace arrives.
        opened = re.match(r'^ {8}id: "([^"]+)",$', line)
        if opened and category:
            pending = {"id": opened.group(1), "name": None, "category": category, "note": None}
            continue
        if pending is not None:
            name = re.match(r'^ {8,10}(?:name:\s*)?"([^"]+)",?$', line)
            if name and pending["name"] is None and "note:" not in line:
                pending["name"] = name.group(1)
                continue
            note = re.match(r'^ {8}note: "([^"]+)",$', line)
            if note:
                pending["note"] = note.group(1)
                continue
            if re.match(r"^ {6}\},$", line):
                if pending["name"]:
                    items.append(pending)
                pending = None

    return items


def describe(name: str, drink: bool) -> str:
    """The visual reading of an item's name, built only from words it contains."""
    table = DRINK_LOOKS if drink else LOOKS
    low = name.lower()
    seen: list[str] = []
    # Longest keys first, so "white nutella" wins over "nutella" — and the
    # substring guard then stops the shorter one being added on top of it.
    for key in sorted(table, key=len, reverse=True):
        if key in low and not any(key in s for s in seen):
            seen.append(key)
    parts = [table[k] for k in seen]
    return ", ".join(parts) if parts else name.lower()


def main() -> int:
    items = parse_menu()
    jobs = []
    for item in items:
        drink = (item["category"] or "") in DRINK_CATEGORIES
        vessel = VESSEL.get(item["category"] or "", "a dessert on a white plate")
        looks = describe(item["name"], drink)
        note = f" Presented in a {item['note'].lower()}." if item.get("note") else ""
        where = "cafe" if drink else "cookie bakery"
        if item["category"] == "cookie-tagines":
            style = TAGINE_STYLE
        elif drink:
            style = DRINK_STYLE
        else:
            style = STYLE
        prompt = (
            f"A single serving of {item['name']} from an Egyptian {where}: "
            f"{vessel}, {looks}.{note} {style}"
        )
        jobs.append(
            {
                "id": item["id"],
                "category": item["category"],
                "name": item["name"],
                "prompt": prompt,
                "ratio": "1:1",
                "model": "Nano Banana Pro",
                "project_name": "Holland Cookies Menu",
            }
        )

    OUT.write_text(json.dumps(jobs, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"{len(jobs)} jobs -> {OUT.relative_to(ROOT)}")
    by_cat: dict[str, int] = {}
    for j in jobs:
        by_cat[j["category"] or "?"] = by_cat.get(j["category"] or "?", 0) + 1
    for cat, n in by_cat.items():
        print(f"  {cat:22} {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
