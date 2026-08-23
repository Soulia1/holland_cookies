# Scooby Cookie — Frontend Motion Audit

Read-only audit of `D:\Web\cs_code_scooby` (storefront only). Nothing in Scooby was
modified. This document is the reference for what motion engineering is worth
transferring to `holland_cookies`, and — just as importantly — what is not.

**Audit date:** 2026-08-23
**Scope audited:** `storefront-src/src/**`, `storefront-src/index.html`, `e2e/*.spec.ts`
**Explicitly out of scope:** `backend/`, `dashboard-src/`, `shared/`, order/checkout/
payment/auth/email logic. None of it was read for transfer purposes.

---

## 1. Technology inventory

What Scooby actually uses, confirmed from `package.json` and import sites — not assumed.

| Technology | Version | Where it is used | Verdict for holland_cookies |
|---|---|---|---|
| **Framer Motion** | ^12.42.2 | Sheets/drawers, modals, page crossfade, magnetic pull, promo popup | **Adopt** — carries the drag-to-dismiss + `AnimatePresence` exit work |
| **GSAP + ScrollTrigger** | ^3.15.0 | Only to drive Lenis on a single clock | **Adopt only if smooth scroll is wanted**; otherwise drop both |
| **Lenis** | ^1.3.25 | Desktop-only smooth scroll | **Optional** — desktop-only by design |
| **Sonner** | ^2.0.7 | Toasts | Adopt if the new site has toasts |
| **Radix Dialog** | ^1.1.18 | Focus trap, `aria-modal`, inert background under sheets | **Adopt** — accessibility, not styling |
| **Canvas 2D** | native | Scroll-scrubbed hero image sequence | **Adopt the engineering**, not the artwork |
| **IntersectionObserver** | native | Scroll reveals, navbar state, hero on-screen gating | **Adopt** |
| **requestAnimationFrame** | native | Hero scroll loop | **Adopt** |
| **CSS keyframes/transitions** | native | Splash, card hover, cart bump, mobile menu | **Adopt patterns** |
| **`createImageBitmap`** | native | Off-main-thread frame decode | **Adopt** if a sequence hero is used |
| WebGL / video / SVG-anim | — | **Not used.** Splash mascot is inline static SVG animated via CSS | n/a |

**No new animation library is needed.** Framer Motion + native APIs cover everything.

---

## 2. Architecture — the part actually worth copying

Scooby's motion is a **layered system**, not per-component animation. This structure is
the single most transferable thing in the codebase.

```
lib/motion/
  tokens.ts        every duration/easing/spring/distance + reduced-motion resolver
  MotionVars.tsx   publishes tokens to CSS custom properties on <html>
  useCapability.ts ONE matchMedia subscriber for reduced/coarse/canHover
lib/scroll/
  scrollController.ts  dependency-free consumer API (scrollTo, setScrollLocked)
  smoothScroll.ts      Lenis+GSAP instance — dynamically imported, desktop only
  ScrollProvider.tsx   lifecycle wrapper
lib/reveal.tsx     shared IntersectionObserver scroll-reveal
lib/splash.ts      boot loader: one controller, one exit
sections/hero/     rendering-mode decision + canvas sequence engine
```

Three design rules hold this together, and each fixed a real defect:

1. **`tokens.ts` is the only file allowed to contain a motion number.** Components
   import the token, never the literal.
2. **`useCapability.ts` is the only caller of `matchMedia`.** One listener set for the
   whole app; every component that answered "is this touch?" itself was another chance
   to forget the reduced-motion check.
3. **`transitionFor()` / `travelFor()` are the only way to get a transition.** A
   component *cannot* forget `prefers-reduced-motion`, because the supported API
   resolves it.

> `MotionVars` was deliberately split out of `ScrollProvider`. Once `ScrollProvider`
> became a lazily-loaded desktop-only module, phones stopped getting the CSS variables —
> and Tailwind classes like `duration-[var(--motion-quick)]` with no fallback are not a
> default, they are an *invalid declaration*, so every header transition silently became
> instant on mobile. **Keep token publishing unconditional and eager.**

---

## 3. Motion inventory

### 3.1 Loading / boot

| Interaction | Scooby File(s) | Trigger | Technique | Mobile Behavior | Reusable? |
|---|---|---|---|---|---|
| Boot splash markup | `index.html` (inline `<style>` + `#boot-splash`) | Document parse, before any JS | Inline CSS + inline SVG, outside React root | Identical | **Yes — pattern is essential** |
| Splash mascot idle | `index.css` `bootCookieStep` 1.15s ∞, `bootSparkTwinkle` 2.4s ∞ | Autoplay | CSS keyframes, loops while waiting | Identical; disabled under reduced-motion | **Yes** |
| Paint gate | `lib/splash.ts` `openPaintGateWhenDrawn()` | Double `rAF` + 400ms fallback | Splash may not exit until browser has *drawn* it | Critical on iOS | **Yes — the core fix** |
| Minimum visible window | `lib/splash.ts` `MIN_VISIBLE_MS = 300` | Measured **from paint**, not navigation | Prevents sub-frame flicker | Identical | **Yes** |
| Hold/release refcount | `lib/splash.ts` `holdSplash()` | Hero takes a hold while frames load | Counter; exit needs *requested + zero holds + painted* | Identical | **Yes** |
| Single exit | `lib/splash.ts` `beginExit()` | Reached from exactly one place | All readiness signals funnel through one gate | Identical | **Yes** |
| Progress bar | `lib/splash.ts` `setSplashProgress()` | Per decoded frame | Direct `style.transform = scaleX()`, outside React | Identical | Yes, if a sequence is used |
| Splash → page morph | `index.css` `bootSplashOut`/`bootMascotMorph`/`bootPageIn` (560ms) | Exit | Mascot launches, `#root` scales up behind | Identical; skipped under reduced-motion | Adapt visuals |
| HTML failsafe expiry | `index.html` `boot-splash-expire` 4s (→14s when `is-held`) | Pure CSS, no JS | Splash retires itself if the bundle never runs | Identical | **Yes — essential** |
| bfcache repair | `lib/splash.ts` `pageshow` listener | `event.persisted` | Removes stale overlay + `is-morphing-in` transform | **Critical on Safari** | **Yes** |

### 3.2 Hero

| Interaction | Scooby File(s) | Trigger | Technique | Mobile Behavior | Reusable? |
|---|---|---|---|---|---|
| Rendering-mode decision | `hero/renderingMode.ts` | Mount + resize/orientation/reduced-motion change | Pure function of capabilities → `desktop`/`mobile`/`static` | Separate 480px tier | **Yes — pattern** |
| Static-first paint | `hero/Hero.tsx`, `StaticHeroFallback.tsx` | Initial bundle | Static hero ships eagerly; animated modes are dynamic imports | Identical | **Yes** |
| Readiness gate | `hero/Hero.tsx` `useHeroSequenceGate` | Module **and** frames both in | Swap held until both resolve → one commit, not two | Identical | **Yes** |
| Scroll scrub loop | `hero/useHeroScroll.ts` | `scroll`, `resize`, `orientationchange`, `visualViewport` | 1 passive listener + 1 rAF, **zero React state** | `visualViewport` listener is iOS-specific | **Yes** |
| Choreography | `hero/heroChoreography.ts` | Pure `progress → composition` | No DOM, no React — unit-testable | Shared by both tiers | **Yes — pattern** |
| Frame blending | `heroChoreography.ts` `blendFor()` | Per frame | Cross-fades neighbours → 48 frames read as continuous | Same | **Yes** |
| Canvas paint | `hero/HeroStage.tsx` `paintCanvas` | Per rAF | `drawImage` + letterbox-band fill only | `MAX_DPR = 1.5` clamp | **Yes** |
| Shared frame store | `hero/heroSequenceStore.ts` | Retain/release refcount | `createImageBitmap` off-thread; last release `.close()`s bitmaps | Mobile tier ≈90MB decoded — refcount matters | **Yes** |
| Off-screen suspend | `useHeroScroll.ts` | IntersectionObserver | Loop stops entirely when hero is off screen | Saves phone battery/CPU | **Yes** |
| Idle-write guard | `HeroStage.tsx` `write()` | Per property | `WeakMap` of last-written values; skips redundant sets | Identical | **Yes** |

### 3.3 Scroll

| Interaction | Scooby File(s) | Trigger | Technique | Mobile Behavior | Reusable? |
|---|---|---|---|---|---|
| Reveal on scroll | `lib/reveal.tsx` | IntersectionObserver, `rootMargin: 0 0 -8% 0` | **One shared observer** for whole page; unobserve after firing | Same | **Yes** |
| Stagger | `lib/reveal.tsx` `STEP_MS=70`, `MAX_STEPS=6` | Index within group | Capped so a long list doesn't read as slowness | Same | **Yes** |
| Reveal self-cleanup | `lib/reveal.tsx` settle timer | `delay + duration + 50ms` | Strips `.reveal` so element regains its own transitions | Same | **Yes — subtle but important** |
| Smooth scroll | `lib/scroll/smoothScroll.ts` | Desktop, non-reduced only | Lenis driven by GSAP ticker; `ScrollTrigger.update` from Lenis | **Disabled on touch** — preserves iOS momentum + URL-bar collapse | **Adopt the exclusion rule** |
| Scroll lock | `scrollController.ts` `setScrollLocked` | Sheet/modal open | Needed because Lenis reads wheel off `window`, bypassing `body` overflow | n/a (no Lenis) | Yes, if Lenis used |

### 3.4 Navigation

| Interaction | Scooby File(s) | Trigger | Technique | Mobile Behavior | Reusable? |
|---|---|---|---|---|---|
| Transparent → solid navbar | `sections/TopBar.tsx` | IntersectionObserver on `#menu-top` sentinel | Reads `entry.boundingClientRect.top <= HEADER_HEIGHT` | Same | **Yes** |
| Sentinel re-attach | `TopBar.tsx` | MutationObserver | Re-resolves sentinel when menu data replaces it | Same | Yes |
| Mobile menu | `index.css` L1419 | `max-height` transition 0.3s | CSS-only | Touch | Adapt |
| Lazy sign-in sheet | `TopBar.tsx` | `useOnceOpened` | Not bundled until first open | Same | **Yes** |

> The navbar's IntersectionObserver replaced a `getElementById` + `getBoundingClientRect`
> on **every scroll tick** — a forced synchronous layout on the main thread while the
> hero was painting, plus two unconditional `setState` calls. Do not regress to that.
>
> Also note the recorded bug: reading bare `isIntersecting` is **wrong** here. It is
> false both when the menu is below the fold and when it has scrolled past — opposite
> situations wanting opposite answers. Read the *side*.

### 3.5 Modals / sheets / cards

| Interaction | Scooby File(s) | Trigger | Technique | Mobile Behavior | Reusable? |
|---|---|---|---|---|---|
| Sheet/drawer | `components/ui/sheet.tsx` | Open state | Radix Dialog + Framer `AnimatePresence`, `forceMount` | Bottom sheet on coarse pointer, side on desktop | **Yes — strong** |
| Drag to dismiss | `sheet.tsx` `onDragEnd` | Touch drag | 35% of size **or** 520 velocity flick | Gesture axis matches entry axis | **Yes** |
| RTL-aware direction | `sheet.tsx` | `dir` prop | Dismiss sign flips for RTL | Same | Only if bilingual |
| Backdrop | `sheet.tsx` | Open | Opacity + `backdrop-blur-[2px]` | Same | Yes |
| Focus trap / inert bg | Radix Dialog | Open | Supplied by Radix, not hand-rolled | Same | **Yes — accessibility** |
| Product sheet | `sections/ItemDetail.tsx` | Card tap | Docked footer (price + CTA) while body scrolls | Bottom sheet | Adapt |
| Card hover lift | `index.css` L971 | Hover | `transform 0.3s, box-shadow 0.3s` | Tap feedback instead | Adapt |
| Card image cycle | `index.css` `menu-card-img-cycle` 10s ∞ | Autoplay | CSS keyframes; **disabled under reduced-motion** | Same | Optional |
| Cart bump / badge | `index.css` `cart-bump`, `cart-badge-in`, `cart-badge-count` | Add to cart | Keyframes using `var(--motion-glide)` | Same | Adapt |
| Page crossfade | `components/PageCrossfade.tsx` | Route change | `initial={false}` so first paint doesn't animate | Same | **Yes** |
| Magnetic pull | `components/ui/magnetic.tsx` + `MagneticPull.tsx` | Pointer proximity | `canHover && !reduced`, lazy-loaded at idle | **Never downloaded on phones** | **Yes — pattern** |
| Promo popup | `sections/PromoPopup.tsx` | 10s delay + `localStorage` | Delayed past CWV window so it can't become LCP | Same | Adapt |
| Toasts | `components/ToastRegion.tsx` | Cart action | Sonner, dynamically imported | Same | Adapt |

### 3.6 Performance scheduling

| Pattern | File | What it does |
|---|---|---|
| `useIdle(timeout)` | `lib/useIdle.ts` | `requestIdleCallback` with a **ceiling, not a delay**. Gates smooth scroll, promo popup, magnetic upgrade, presence heartbeat. |
| `useOnceOpened` | `lib/useOnceOpened.ts` | Mounts heavy surfaces on first open, keeps them after close. |
| Dynamic imports | `CartDrawer`, `ItemDetail`, `SignInSheet`, `ToastRegion`, `ScrollProvider`, hero modes | Keeps Framer Motion / Lenis / GSAP / Sonner out of the critical bundle. |

---

## 4. Mobile Safari / WebKit lessons — the highest-value content

These are recorded fixes with measurements. Carry every one forward.

**4.1 The splash was never painted (the flagship bug).**
A reduced-motion visitor took no hero hold, so `dismissSplash()` retired the splash on
React's first commit. Measured on iPhone WebKit: node removed at **~125ms**, first
contentful paint at **~145ms**. The loader was in the DOM the whole time and was
**never once painted** — 12/12 loads showed the site directly. Desktop WebKit under the
same preference failed identically, so this was never a mobile code path, only a mobile
*setting*. The margin was **13–25ms**, which is why the same phone showed the splash on
one load and skipped it on the next.
**Fix:** paint is a *precondition* (double `rAF`), not a side effect.

**4.2 Double `rAF` is required.** A single `requestAnimationFrame` callback runs *before*
the paint it belongs to, so it proves nothing. The second one proves a frame committed.

**4.3 `rAF` never fires in an undrawn document.** Background tab or backgrounded phone →
the splash would wedge forever. `PAINT_GATE_FALLBACK_MS = 400` plus a
`visibilityState === "hidden"` short-circuit.

**4.4 `visualViewport` is mandatory on iOS.** Safari resizes the visual viewport as
toolbars collapse **without firing `resize`**. Without a `visualViewport` listener the
hero is measured against a height up to ~60px stale for the rest of the visit.

**4.5 Never cache layout offsets.** `getBoundingClientRect` on the frame, every frame —
because iOS toolbar collapse silently drifts any cached offset.

**4.6 bfcache leaves live state behind.** Safari restores the document without re-running
boot. Two states must be repaired on `pageshow`/`persisted`: a stale splash over a
finished page, and `is-morphing-in` left on `#root` — which is a **live transform**,
making `#root` the containing block for the fixed header, so the header detaches from
the viewport on the next scroll.

**4.7 Transformed ancestors break `position: fixed`.** `pageMayMorph()` only lets the
page participate in the morph when `scrollY === 0`, precisely because of 4.6.

**4.8 Old WebKit needs intrinsic dimensions on SVG.** `width`/`height` attributes *and*
CSS width — WebKit does not derive an aspect ratio from `viewBox` alone and collapses
`height: auto` to zero.

**4.9 Don't intercept touch scroll.** Lenis on touch breaks iOS momentum and the URL-bar
collapse — ~60px of viewport is worth more than easing.

**4.10 Clamp DPR.** `MAX_DPR = 1.5`. A DPR-3 phone otherwise rasterises 9× the area per
scroll frame for a source that cannot fill it.

**4.11 `React.lazy` costs two commits.** `lazy` suspends on first render of an
uninitialised module *even when the chunk is in memory*; React commits the fallback and
retries. Holding the resolved component in state makes the upgrade one commit — which is
what lets the splash lift on the exact frame the hero appears.

---

## 5. Regressions to NOT reintroduce

Recorded in Scooby's own comments as things that were tried and failed.

| Anti-pattern | Why it failed |
|---|---|
| Removing splash on React commit | Never painted on WebKit — bug 4.1 |
| A longer arbitrary timeout as the "fix" | Explicitly rejected; the 560ms morph only ever masked it by accident |
| Gating hero upgrade on "splash still visible" | Sequence is ~2MB; on real connections it lands after the splash → **no visitor ever got the animation.** Only looked right locally |
| Upgrading hero on first idle callback | Idle fires long before a megabyte of frames; canvas mounted empty |
| Loading frames inside `useHeroSequence` | Frames only started when canvas mounted — too late |
| Two separate desktop/mobile renderers | Drifted until only one worked on iOS. Now one `HeroStage` |
| Translating the stage element for the drop | Vacated strip showed cream under the transparent header → looked like a solid nav slab. Move the frame *inside* the canvas instead |
| Filling whole canvas then drawing over it | 1.3M wasted px/frame; p95 hit **33.3ms with 10 dropped of 139**. Fill only the letterbox bands |
| Gradient fill on horizontal bands | Interpolated across full height → mismatch resolves as a hard line. Sample the frame's own edge colours |
| Latching subtitle/CTA to furthest scroll | Copy read as stuck; collided on the way back up |
| Headline drifting after arrival | Read as "down, then back up again" |
| Bare `isIntersecting` for navbar state | False in two opposite situations — see §3.4 |
| `test.use({ reducedMotion })` in Playwright | **Did not reach the page** under this config. Every test read as reduced-motion coverage while running the ordinary path — which is how the original bug survived a suite that already had a reduced-motion case. Use `page.emulateMedia()` **and assert the preference is active** |
| Per-component `matchMedia` | Dozens of listeners; each one a chance to forget reduced-motion |
| Per-element IntersectionObserver | Real cost on phones for an identical answer |
| Leaving `.reveal` on after animating | Overrode the element's own hover transition and made hover wait out the stagger delay |
| `will-change` / `#root` transform left after morph | Pins a compositing layer for the page's life and breaks the fixed header |

---

## 6. Existing test coverage worth replicating

`playwright.webkit.config.ts` runs two projects: **`iphone`** (iPhone 13 device profile)
and **`desktop`** (1440×900 WebKit).

`e2e/splash-lifecycle.spec.ts` — the assertion model is the valuable part. It records
FCP via `PerformanceObserver` and splash removal via `MutationObserver`, both installed
with `addInitScript` before app code runs, then asserts **`removedAt > fcp`**. Asking
"is `#boot-splash` in the document" answers yes right up until it stops mattering.

Cases covered: splash present at `commit`; **20 repeated cold loads** (iPhone) / 8
(desktop); 10 warm-cache loads; 6 rapid reloads; instant-cache hero (the case that used
to outrun first paint); delayed sequence; failed sequence → static fallback; SPA nav does
not replay splash; bfcache residue cleared; reduced-motion ×10 with the preference
asserted; mascot idle animation disabled under reduced-motion.

`e2e/safari-hero.spec.ts` — real build output for frames, deliberately slowed requests
for a deterministic observation window, console-error collection.

**This test design transfers directly and is the cheapest way to avoid re-living §4.**

---

## 7. Explicitly NOT transferring

**Brand** — logo, wordmark, mascot SVG, cookie photography, tin images, cream `#FBF5DE` /
brown `#6E3119` / `#A9683A` palette, self-hosted fonts, product names, all copy, the
Bakery JSON-LD, OG images. `holland_cookies` gets its own identity.

**Business/backend** — `backend/`, `dashboard-src/`, Firebase/Firestore rules and
indexes, auth, checkout, promo codes, delivery/cutoff logic, presence, i18n content,
order recovery. Not read for transfer.

**Structural coupling** — `HeroStage` reads `useLang()` and hardcodes a mascot `<img>` in
the CTA. The motion layer must be lifted away from content bindings: keep the
choreography and the scroll/canvas engine, pass copy and imagery in as props.

**Possibly not needed** — Lenis + GSAP (desktop-only smoothing, ~large dep for the
benefit); RTL sheet handling (only if bilingual); the 10s promo popup.

---

## 8. Recommended transfer plan for holland_cookies

**Tier 1 — take nearly verbatim (mechanism is brand-neutral):**
`lib/motion/tokens.ts`, `MotionVars.tsx`, `useCapability.ts`, `lib/reveal.tsx`,
`lib/useIdle.ts`, `lib/useOnceOpened.ts`, `lib/splash.ts` (retune visuals only),
the `index.html` inline-splash + CSS-failsafe pattern, `components/ui/sheet.tsx`.

**Tier 2 — take the pattern, rebuild the content:**
Hero rendering-mode decision, static-first + gated upgrade, `useHeroScroll`, pure
choreography module, navbar sentinel observer, card interactions, magnetic pull.

**Tier 3 — take only if the design calls for it:**
Canvas image-sequence hero (only if there's a comparable scrubbed sequence), Lenis
smooth scroll, promo popup, toasts.

**Tier 4 — do not take:** everything in §7.

**Suggested order:** tokens + capability → splash (with WebKit tests immediately) →
reveal → nav → sheets/modals → hero last (largest, most WebKit-sensitive).

---

## 9. Open questions — resolved 2026-08-24

These were the blockers before implementation. All are now answered; the outcome of
each is recorded in `FRONTEND_PARITY_REPORT.md`.

1. ~~The `holland_cookies` project does not exist yet, and the source design was never
   provided.~~ **Resolved.** The design came from the Google Stitch project
   "Artisan Cookie Atelier" (`projects/7343113407578589651`), screen "Holland Cookies |
   Premium Artisan Redesign" — a redesign of `hollandcookies.lovable.app`.
2. ~~Framework?~~ **Resolved: Vite + React 19 + Tailwind 4**, matching Scooby, so the
   Tier 1 list ported nearly verbatim.
3. ~~Is there a scrubbed hero at all?~~ **No.** The design has one still photograph, so
   the canvas sequence engine was correctly not built. The splash hold was adapted to
   wait on that photograph's decode instead — same mechanism, different subject.
4. ~~Bilingual?~~ **No.** English only, so the RTL sheet handling did not come along.
