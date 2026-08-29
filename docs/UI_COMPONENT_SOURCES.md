# External UI sources

Every third-party component, registry or pattern that was **researched**, and what
was done with it. The point of this file is that nothing in this codebase should
be untraceable pasted code.

The short version: **nothing was installed.** The dependency list is unchanged —
React, React DOM, Radix Dialog, Framer Motion. Two patterns were adapted by hand
from open-source sources, with the reasoning recorded below.

---

## Adapted (concept taken, code written here)

### Sliding category indicator — `.cat-indicator`

| | |
|---|---|
| **Source** | Motion Primitives `AnimatedBackground` |
| **URL** | https://motion-primitives.com/docs/animated-background · source read from `github.com/ibelick/motion-primitives` → `components/core/animated-background.tsx` |
| **Licence** | MIT (project states MIT; no `LICENSE` file at repo root on `main` at time of reading — recorded as a caveat, and moot because no code was copied) |
| **Original purpose** | A shared-element background that slides between tabs using Framer Motion's `layoutId`. |
| **What we took** | The *idea*: one travelling element instead of N backgrounds cross-fading. |
| **What we wrote** | `src/pages/MenuPage.tsx` (`useLayoutEffect` measuring `offsetLeft`/`offsetWidth`) plus `.cat-indicator` in `src/index.css`. Two custom properties and a CSS transition. |
| **Why not install it** | Two hard reasons. (1) It owns its own `activeId` state and sets it on click — this page's active category is decided by a **scrollspy**, so the component would have fought the thing that actually knows the answer. (2) It imports `motion/react`; Framer Motion is currently code-split into the product-dialog chunk, so importing it here would move ~45KB gzip onto the critical path of both pages to animate one rectangle. It also relies on `cloneElement` over children, which constrains the markup. |
| **Used in** | The `/menu` category bar. |
| **Dependencies added** | None. |

### Responsive dialog → bottom sheet

| | |
|---|---|
| **Source** | shadcn/ui `Drawer`, which wraps **Vaul** (Emil Kowalski) |
| **URL** | https://ui.shadcn.com/docs/components/base/drawer · https://vaul.emilkowal.ski |
| **Licence** | MIT |
| **Original purpose** | Replace a centred dialog with a draggable bottom sheet on touch devices. |
| **Outcome** | **Rejected — already solved.** `src/components/PanDetail.tsx` already renders a bottom-anchored sheet with a drag handle on coarse pointers and a centred dialog on fine ones, on top of Radix Dialog. Measured: 390×611 anchored to the bottom edge on iPhone 13, 560×774 centred on desktop. Installing Vaul would have added a dependency to reproduce behaviour that exists and is under test. |
| **Dependencies added** | None. |

---

## Researched and rejected

| Source | Considered for | Why rejected |
|---|---|---|
| **shadcn/ui** (Button, Tabs, Carousel, Scroll Area, Dialog) | Foundational primitives | The project already uses Radix Dialog directly, which is what shadcn wraps. shadcn's value is its token layer (`--background`, `--foreground`, `--primary`…) and this project has its own `@theme` token system with a different vocabulary. Adopting it would mean either running two token systems or restyling every component — for primitives we already have. No `components.json` was created. |
| **Aceternity UI** | Scroll effects, hero mechanics, text effects | Its signature pieces are glow beams, spotlight gradients and WebGL-flavoured backgrounds built for SaaS landing pages. This is a bakery — the product photography is the visual, and a decorative effect competing with it makes the site worse, not better. Nothing adopted. |
| **Magic UI** | Animated borders, marquee, gradients | Same reason. A marquee of category names would actively harm a menu whose job is scanning 105 items. |
| **Kokonut UI / Cult UI** | A signature moment | The site already has its signature moments (the pan's arrival turn and scroll turn, the boot splash's paint gate). The brief's own rule — 2–4 memorable interactions, not 20 — argued against adding a fourth from a library. |
| **Origin UI / Ruixen / HextaUI** | Navbar, cards, footer composition | Used as *reference* for proportion only. The footer and rail were built to specific screenshots the user supplied, which is a stronger brief than a generic registry component. |
| **21st.dev** | Design discovery | Used for discovery only. No component installed. |

---

## Not used, and why it matters

No `components.json`, no shadcn CLI, no registry entries in this project. That is
a deliberate outcome, not an oversight: the brief asked for a site that does not
look like a component-library demo, and the fastest way to fail that is to let
five registries each bring their own radius, shadow and easing.

`package.json` dependencies before this pass and after it are identical.
