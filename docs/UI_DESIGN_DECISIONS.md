# UI design decisions

Why the interface is the way it is. Companion to `UI_COMPONENT_SOURCES.md`,
which records where external ideas came from.

## The audit that started this pass

Every surface was rendered at 1440×900 and iPhone 13 and graded.

| Area | Grade | Note |
|---|---|---|
| Our Craft | **Excellent** | Navy panel, numbered steps, real hierarchy. The strongest section; untouched. |
| Hero | **Good** | Composition, arrival turn and scroll turn already carry the page. |
| Menu page | **Good** | Editorial and dense; the category bar was inert. |
| Footer | **Good** | Built to a supplied reference; carries real contact data. |
| Best-sellers rail | **Needs improvement** | Bare cards, CTA buried under the lede. |
| Product dialog | **Needs improvement** | Bottom sheet already correct; "Close" occupies a primary button slot. |
| Navbar | **Needs improvement** | Page text legible *through* it on a phone. |
| Build Your Box | **Poor on mobile** | Selecting a box changed nothing you could see. |
| Consistency | **Needs improvement** | Radius ran 2px / 4px / 8px / 28px with no scale. |
| Accessibility | **Good** | Radix dialog, radiogroup, `aria-live`, reduced motion honoured throughout. |
| Performance | **Excellent** | 72KB gzip, one shared IntersectionObserver, no animation library on the critical path. |

The two entries in bold-adjacent positions — Build Your Box and the navbar — were
**bugs**, not taste. They were fixed first, before anything that could be called
polish.

## Direction: editorial, food-forward, restrained

Three directions were considered against the brand as it actually exists (a
Playfair/Hanken palette on oat, burgundy and navy, with strong food photography):

- **Editorial restaurant** — large type, photography does the talking, motion is
  structural rather than decorative.
- **Modern boutique** — soft surfaces, heavy glass, lots of easing.
- **Expressive contemporary** — creative navigation, experimental motion.

**Chosen: editorial.** The deciding argument is that this site's best asset is
the photography, and the second-best is the printed menu's sheer size — 17
categories and 105 items. Both reward calm. Expressive navigation would fight the
menu; boutique glass would fight the food. The one place the site is allowed to
be showy is the hero, and it already is.

## Decisions

### The radius scale was the biggest single consistency win

Radius ran `2px` (buttons, dialog actions), `4px`, `8px` (cards) and `28px`
(sheet) with nothing relating them. At 2px a corner does not read as a decision,
it reads as a rendering artefact — which is exactly why the product dialog looked
unfinished next to the cards. Now `8 / 14 / 20 / 28`, picked by surface size.
Because these are Tailwind `@theme` keys, every existing `rounded-*` in the
codebase moved onto the scale at once.

### The category indicator is CSS, not Framer Motion

The interaction is the shared-element pattern (see `UI_COMPONENT_SOURCES.md`).
The implementation is two custom properties and a transition, because the
library version owns the state that the scrollspy needs to own, and because
Framer Motion is currently code-split behind the product dialog — importing it
into the menu page would put ~45KB gzip on the critical path of every visit to
animate one rectangle. Verified: the indicator lands aligned to the active pill
within 0px at every category, and animates both `transform` and `width`.

`useLayoutEffect`, not `useEffect`: measuring and writing after paint shows one
frame of the indicator in its previous position, which is visible as a stutter.

### The navbar is solid, not glass

It was `bg-soft-oat/92` with `backdrop-blur-md`. On a phone, page text read
straight through it — visible in the audit screenshots over both the box section
and the menu. Glass only works when it is convincing; at 92% over dense type it
is just a legibility bug with a blur on top. It is now opaque with a hairline,
and stays transparent *only* over the hero, which is the one place it has
something worth showing through to.

### Build Your Box is ordered by grid areas

Source order — options, photo, price — is right on a desktop and wrong on a
phone, where it put every consequence of a tap a screen and a half below the
control. `grid-template-areas` lets the two layouts disagree: on a phone the
photo and price sit *above* a single swipeable row of options, so the thing you
are choosing is the thing you are looking at. The next chip deliberately peeks
past the right edge — that is the affordance that says the row scrolls, and it
costs nothing.

### What was deliberately not added

No scroll-jacking, no parallax, no marquee, no gradient beams, no page-transition
overlay. The menu page's job is letting someone find a Lotus cheesecake and its
price; every one of those would have made that slower. The brief's own standard —
one exceptional interaction over ten mediocre ones — is the reason the category
indicator got the effort and nothing else did.

### Signature moments (three, on purpose)

1. **The pan's arrival** — a 118° turn over 1800ms on a symmetric curve, held
   until the photograph has decoded so it is never played behind the splash.
2. **The pan tracking the scroll** — 0→26° across one screen, then capped.
3. **The category indicator** — one element that travels and resizes across 17
   categories, driven by where you actually are on the page.

Everything else is transition, not performance.

## Accessibility positions

- The decorative `MENU` word is `aria-hidden` with `pointer-events: none`, and
  its opacity is capped under 0.15 so it can never fight the text over it.
- The category bar is buttons with `aria-current`, not links — they move the
  viewport, they do not navigate.
- Box options are a `radiogroup`, so a keyboard user gets arrow keys between
  four mutually exclusive choices rather than four tab stops.
- The box detail panel is `aria-live="polite"`: on a phone the price is the only
  feedback a tap produces, and a screen reader would otherwise get nothing.
- The footer's focus ring is overridden to white — the site's burgundy ring is
  invisible inside a burgundy panel.
- Every animation added in this pass has a `prefers-reduced-motion` branch, and
  the reduced-motion path is asserted in `e2e/storefront.spec.ts` — including
  that nothing is left hidden at `opacity: 0` when the motion is removed.

## Still weak

- **Box photography is placeholder.** Three of the four box options reuse pan
  shots. `src/data/boxes.ts` says so at the top; swap `image` and nothing else
  changes.
- **The best-sellers rail** was graded "needs improvement" and was not
  rebuilt this pass — the two bugs and the design system took precedence.
- **The type scale is defined but not yet applied everywhere.** Sections touched
  in this pass use it; the older sections still carry literal sizes.
- **Menu items have no per-category visual anchor.** At 17 categories, every
  section looks identical apart from its heading.
