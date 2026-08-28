# Holland Cookies — Frontend Parity Report

What was taken from `cs_code_scooby`, what was adapted, what was deliberately
left behind, and what was actually tested.

**Date:** 2026-08-24
**Source of design:** Google Stitch project `projects/7343113407578589651`
("Artisan Cookie Atelier", design system "The Artisanal Dutch Library"),
screen "Holland Cookies | Premium Artisan Redesign" (2560×9358, desktop).
**Motion reference:** `D:\Web\cs_code_scooby` — read-only. **Not modified.**
**Companion document:** `docs/SCOOBY_FRONTEND_MOTION_AUDIT.md`

---

## 1–2. Scooby dynamics and animations discovered

Catalogued in full in the audit document — 11 loading/boot behaviours, 10 hero
behaviours, 5 scroll behaviours, 4 navigation behaviours, 13 modal/card/
micro-interaction behaviours, and 3 performance-scheduling patterns. The
technology inventory found Framer Motion, GSAP + ScrollTrigger, Lenis, Sonner,
Radix Dialog, Canvas 2D, IntersectionObserver, `requestAnimationFrame` and
`createImageBitmap`. No WebGL, no video, no SVG animation library.

## 3. Scooby files used as reference

| File | What it contributed |
|---|---|
| `storefront-src/src/lib/motion/tokens.ts` | The whole token model + `transitionFor`/`travelFor` |
| `storefront-src/src/lib/motion/useCapability.ts` | Single-subscriber capability model |
| `storefront-src/src/lib/motion/MotionVars.tsx` | Eager CSS-variable publication, and why it must stay eager |
| `storefront-src/src/lib/splash.ts` | The paint gate, hold refcount, single exit, bfcache repair |
| `storefront-src/index.html` | Inline splash + CSS failsafe pattern |
| `storefront-src/src/lib/reveal.tsx` | Shared observer, capped stagger, self-stripping class |
| `storefront-src/src/sections/hero/Hero.tsx` | Readiness-gated hero, hold + ceiling |
| `storefront-src/src/sections/hero/renderingMode.ts` | Capability-driven mode decision |
| `storefront-src/src/sections/TopBar.tsx` | Observer-driven header state; the `isIntersecting` trap |
| `storefront-src/src/components/ui/sheet.tsx` | Radix + Framer composition, `forceMount`, scroll lock |
| `storefront-src/src/lib/useOnceOpened.ts` | Mount-on-first-open for heavy surfaces |
| `e2e/splash-lifecycle.spec.ts` | The FCP-vs-removal assertion model |
| `playwright.webkit.config.ts` | Two-project iPhone/desktop WebKit setup |

## 4. Effects transferred (essentially as-is)

- **Motion token system** — `src/lib/motion/tokens.ts`. Durations, easings,
  springs, travel, stagger, `transitionFor()`, `travelFor()`, `motionCssVars()`.
- **Capability model** — `src/lib/motion/useCapability.ts`. One `matchMedia`
  subscriber for the whole app, conservative pre-hydration snapshot.
- **Eager CSS variables** — `src/lib/motion/MotionVars.tsx`, with the comment
  explaining why it must never move behind a lazy module.
- **Boot splash controller** — `src/lib/splash.ts`. Paint gate (double `rAF` +
  400ms backstop), `MIN_VISIBLE_MS` measured from paint, hold refcount, single
  exit, `pageshow`/`persisted` repair, `?splashdebug` instrumentation.
- **Inline splash + CSS failsafe** — `index.html`. 4s self-expiry, 14s when held.
- **Scroll reveal** — `src/lib/reveal.tsx`. One shared observer, unobserve after
  firing, capped stagger, class stripped on settle.
- **Mount-on-first-open** — `src/lib/useOnceOpened.ts`.
- **Radix + Framer dialog composition** — `src/components/PanDetail.tsx`.

## 5. Effects adapted

| Scooby | Holland | Why |
|---|---|---|
| Splash holds for a 48-frame scroll sequence | Holds until the hero photograph **decodes** (`img.decode()`) | Same role — the one asset the page is visibly wrong without — different subject |
| `SEQUENCE_WAIT_CEILING_MS` 10s | `IMAGE_WAIT_CEILING_MS` 8s | One image is faster than a megabyte of frames |
| Mascot SVG, cookie + sparkles | Original pan/steam SVG mark | Scooby's mascot is their brand; the mechanism (inline vector = FCP, no request, animatable parts) is the transferable part |
| Header sentinel at top of menu | Observes the **hero** instead | See §20 — the sentinel approach has a real defect |
| Sheet with drag-to-dismiss | Bottom sheet on coarse, centred panel on fine; no drag | Drag needs a gesture surface worth the code; this dialog is short |
| Hero entrance gated on frames | CSS one-shot stagger + plate/inset entrance | No sequence in this design |
| `stagger`/`duration` duplicated in reveal | `reveal.tsx` imports from `tokens.ts` | Scooby's own stated rule, applied more strictly than Scooby applies it |

## 6. Deliberately NOT transferred

| Not taken | Why |
|---|---|
| Canvas scroll-scrubbed sequence engine (`heroSequenceStore`, `HeroStage`, `frameFit`, `heroChoreography`, `useHeroScroll`) | **The design has no frame sequence.** Building a 2MB scrub engine for a single still would be engineering for its own sake. The audit flagged this as conditional from the start. |
| Lenis + GSAP smooth scroll | Two large dependencies for desktop-only easing. Native scroll + `scroll-behavior: smooth` covers this design. Revisit if the design gains parallax. |
| Magnetic pull | Reads as "expensive" on a playful brand; this one is editorial and restrained. Would fight the typography. |
| Sonner toasts | Nothing here produces a transient confirmation — there is no cart. |
| `useIdle` | Ported, then **deleted**: nothing in this build defers work, and shipping an unused module is dead code. Trivial to restore. |
| All backend/business logic | Out of scope by instruction. Never read for transfer. |
| Scooby brand | Logo, mascot, cookie imagery, cream/brown palette, fonts, copy, product names, JSON-LD, OG images. |

## 7. Files created

```
holland_cookies/
├── index.html                      inline splash, fonts, meta
├── vite.config.ts                  alias, manual motion chunk
├── tsconfig.json  package.json  .gitignore
├── playwright.webkit.config.ts     iphone + desktop WebKit projects
├── public/img/                     7 images, downloaded from Stitch
├── docs/
│   ├── SCOOBY_FRONTEND_MOTION_AUDIT.md
│   └── FRONTEND_PARITY_REPORT.md
├── e2e/
│   ├── splash-lifecycle.spec.ts    11 tests
│   └── storefront.spec.ts          9 tests
└── src/
    ├── main.tsx  App.tsx  index.css
    ├── data/pans.ts
    ├── lib/
    │   ├── splash.ts  reveal.tsx  useOnceOpened.ts
    │   └── motion/tokens.ts  useCapability.ts  MotionVars.tsx
    ├── components/PanDetail.tsx
    └── sections/TopBar.tsx  Hero.tsx  MenuGrid.tsx  Craft.tsx  Visit.tsx  Footer.tsx
```

## 8. Hero implementation

`src/sections/Hero.tsx`. **Rebuilt from a reference recording** (2026-08-29):
one full screen, centred copy over a single circular pan that bleeds off the
bottom edge, with drawn ingredients drifting around it. It replaces the earlier
two-column copy-beside-photograph hero; the splash contract, the ceiling and the
reduced-motion handling are unchanged, only the composition and the subject.

Copy is real markup, never gated on the image — a visitor who lands and does not
scroll is still told what the place sells. The pan is `loading="eager"` +
`fetchPriority="high"` (it is the LCP candidate and the asset the splash waits
on) and is preloaded from `index.html` with the same `type`/`srcset` set the
`<picture>` uses, so preload and element resolve to one file. A hold is taken on
mount, `img.decode()` is awaited **on the rendered element** rather than on a
second `new Image()` — `<picture>` means the browser picks the rendition, and a
guess would either gate on a file nothing is waiting for or fetch the hero
twice. The hold is released with reason `hero-ready`; an 8s ceiling releases
with `hero-wait-ceiling`. Entrance is CSS, keyed to the same readiness flag so it
does not play behind the splash: copy children stagger at 60/160/260ms, the pan
scales in at 120ms, the ingredients follow from 420ms at 90ms apart.

**Asset note.** `public/img/cookie-plate.*` is the pan cut to a circle out of
`hero-main.jpg` (1408x768) — a 762px circle, which is all the detail that
exists. Hence `--pan-size` is capped at 680–820px rather than at whatever the
layout would allow, and the `@2x` files are an offline Lanczos + unsharp upscale
of that same 762px, not a higher-resolution capture: a retina display resamples
to ~1360 device pixels either way, and doing it once offline with a good kernel
beats the browser doing it every paint. Three formats (AVIF 128KB / WebP 226KB /
PNG 1.2MB); there is deliberately no 2x PNG, since it would be 4MB and nothing
that falls back to PNG wants it.

The ingredients (`src/components/CrumbField.tsx`) are inline SVG, not cut-out
photographs — a chocolate chip is three tones and a highlight, so a vector beats
a masked JPEG on fidelity, on sharpness at any size, and on not competing with
the hero image for bandwidth. Placement, size, tilt and drift period are data in
one array; phones drop half of them and move the rest off the headline.

## 9. Loading implementation

Covered in §4. The load-bearing property: **the splash cannot leave until the
browser has painted it**, regardless of how fast readiness resolves. Cache state
decides how fast the loader goes, never whether it appeared.

## 10. Scroll animation implementation

`src/lib/reveal.tsx` + `.reveal` rules in `index.css`. One `IntersectionObserver`
for the page, `rootMargin: "0px 0px -8% 0px"`, unobserve on fire, stagger capped
at 6 steps, class stripped after `delay + duration + 50ms` so elements regain
their own transitions. Reduced motion short-circuits to the finished state in
the callback ref — content is never left hidden behind an effect that cannot run.

## 11. Modal animation implementation

`src/components/PanDetail.tsx`. Radix Dialog supplies focus trap, `aria-modal`
and inert background; `forceMount` hands unmount timing to `AnimatePresence` so
the exit actually runs. Backdrop fades; the panel springs up from the bottom
edge on coarse pointers and scales into the centre on fine ones. Body scroll is
locked with scrollbar-width compensation. **Focus return is implemented
manually** — see §20.

## 12. Navigation interactions

`src/sections/TopBar.tsx`. Transparent over the hero, `bg-soft-oat/92` +
`backdrop-blur` + hairline once past it, decided by an `IntersectionObserver` on
the hero — no scroll listener, no forced layout. Mobile menu animates
`grid-template-rows: 0fr → 1fr` (no `max-height` guess), closes on Escape, on
link tap, and on resize past the breakpoint; `inert` keeps its links out of the
tab order while collapsed. Hamburger is two CSS-transformed bars, no icon font.

## 13. Micro-interactions

Button hover lift + shadow (fine pointers only), 1px press drop on all pointers,
card hover lift + 1.05 image scale (fine pointers), `scale(0.985)` press on
coarse, nav and footer link colour transitions, craft numerals brightening on
row hover, logo opacity on hover, brand-coloured `:focus-visible` ring
throughout, skip-to-menu link.

## 14. Mobile-specific behaviour

Bottom-sheet dialog with grab handle vs centred desktop panel; press feedback
instead of hover (`@media (pointer: coarse)`); hover rules fenced behind
`(hover: hover) and (pointer: fine)` so no lift can stick after a tap; mobile
nav panel; `dvh` units for the dialog's max height; single-column grids.

## 15. Safari/WebKit safeguards

- Paint gate before splash exit (double `rAF`), with a 400ms backstop.
- `visibilityState === "hidden"` short-circuit — `rAF` never fires in an undrawn
  document.
- `pageshow`/`persisted` clears a stale splash **and** the `is-entering`
  transform, which would otherwise make `#root` the containing block for the
  fixed header.
- `pageMayMorph()` only lets the page animate when `scrollY === 0`, for the same
  reason.
- Inline SVG carries explicit `width`/`height` attributes — older WebKit will not
  derive an aspect ratio from `viewBox` alone and collapses `height: auto` to 0.
- Splash is styled entirely by the document, never by JavaScript.
- One-pixel/zero-area IntersectionObserver targets avoided entirely (§20).

## 16. Performance

Framer Motion is a separate 135KB chunk and the dialog another 42KB — **neither
is in the entry bundle the hero waits on**; both load on first card open. Entry
is 208KB / 65KB gzipped. One shared observer rather than one per element; one
`matchMedia` subscriber for the app. Only `transform` and `opacity` are
animated. `will-change` is applied only while `.reveal` is active and removed
with the class; the splash's `will-change` is removed with its node. Below-fold
images are `loading="lazy"`; the hero is eager and high-priority.

## 17. Reduced-motion support

`transitionFor()`/`travelFor()` are the only supported way to get a transition
or a distance, so a component cannot forget the preference. `@media
(prefers-reduced-motion: reduce)` blocks neutralise the reveal, hero entrance,
splash idle + exit, page entry, card hover/press, button press, and mobile-menu
transition, and set `scroll-behavior: auto`. The loader still appears and still
stays up for its minimum visible window — the preference removes *movement*, not
the loading screen.

## 18–19. Tests performed and exact results

`npx playwright test --config playwright.webkit.config.ts`

**Final run: 37 passed, 3 skipped, 0 failed** (2.7 min). The 3 skips are the
phone-only tests correctly skipped on the desktop project.

Per project — **iPhone 13 WebKit: 20/20 passed. Desktop WebKit (1440×900):
17/17 passed, 3 skipped.**

Splash lifecycle (11): bundle blocked entirely → splash still fixed, opaque,
covering; **20 repeated cold loads (iPhone) / 8 (desktop)**; 10 warm-cache loads
(iPhone) / 5; 6 rapid reloads; delayed hero image holds the splash; failed hero
image still releases inside the ceiling; bfcache residue cleared and page still
scrollable; reduced motion painted + left, with the preference asserted;
**10 repeated reduced-motion loads**; mascot idle animation disabled under
reduced motion.

Storefront (9): all sections present with **zero console errors**; hero
photograph actually painted (`naturalWidth > 0`); all three cards reveal;
dialog opens, traps focus, closes on Escape, restores focus to the opening card;
dialog closes on backdrop click; header transparent over hero and solid past it;
anchor navigation reaches each section; mobile menu opens/navigates/closes;
dialog fits the phone viewport and reaches the bottom edge; **no horizontal
overflow** at any section.

Also: `tsc --noEmit` clean; `vite build` clean.

## 20. Remaining differences, and two real defects found during testing

**Two genuine bugs were found and fixed — not worked around in the tests.**

1. **Focus was never returned when the dialog closed.** Radix restores focus
   only for dialogs opened through its own `DialogTrigger`. These cards open it
   programmatically, so Radix had nothing to return to and a keyboard user was
   dropped at the top of the document. Fixed in `MenuGrid.tsx`: the opening
   element is captured and refocused on the frame after close.

2. **The header did not update on a jump.** With a 1px sentinel at the top of
   the menu, jumping from the top of the page straight to a section moves it
   from below the viewport to above it in one step. `IntersectionObserver` fires
   only on threshold crossings, so 0 → 0 fires nothing and the bar kept its old
   state — following "Visit" from the top left a transparent header over
   content. Fixed by observing the **hero** instead: it is a full screen tall, so
   any jump past it necessarily changes intersection, and as the first element
   in the document it has no ambiguous "not yet reached" case.

3. **The scroll reveal had the same defect, found by the hero rebuild.** An
   `IntersectionObserver` reports where its targets are when it *delivers*, not
   every position they passed through. An element that is below the viewport on
   one delivery and above it on the next crosses no threshold and receives no
   callback at all — so it stayed at `opacity: 0` for the life of the page.
   Latent before; the new hero is a screen shorter than the old one, which moved
   the menu close enough to the top that the first card lands in that window on
   a phone. Reproduced 4/4 by instrumenting `IntersectionObserver` and dumping
   every delivery: one batch, at `scrollY: 1756`, listing cards 2 and 3 and
   never mentioning card 1. Fixed in `reveal.tsx`: whenever a delivery reveals
   anything, elements still waiting whose bottom edge is already above the
   viewport are revealed too. Covered by `a card the viewport jumps clean past
   still reveals`, verified to fail against the previous `reveal.tsx`.

**Three test bugs** were also fixed, each of which had made a test measure
something other than what it claimed: sampling the reveal mid-transition;
sampling the header while `scroll-behavior: smooth` was still animating; and
reading computed styles at `domcontentloaded`, where WebKit returns initial
values while render-blocking stylesheets are pending.

**Known differences from Scooby, all intentional:** no scroll-scrubbed hero, no
smooth-scroll layer, no magnetic pull, no toasts, no drag-to-dismiss. Each is
recorded with its reason in §6.

**Not yet done:** no visual regression baseline; contact details
(`+201000000000`, Nasr City) are the Stitch placeholders and need real values;
images are Stitch's AI renders at ~50KB JPEG and should be replaced with real
photography and served as AVIF/WebP at multiple widths; `logo.jpg` should be a
transparent PNG/SVG rather than a JPEG.
