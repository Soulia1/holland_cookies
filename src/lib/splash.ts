/**
 * The boot splash: one controller, one exit.
 *
 * The element lives outside the React root deliberately: it has to be on screen
 * during the blank window between the HTML arriving and the bundle executing,
 * which is exactly the period React cannot cover. index.html paints it before
 * any JavaScript runs; this module is the only thing that takes it away.
 *
 * It comes down when three things are all true: something has asked it to go,
 * nothing is holding it, and the browser has actually put it on screen. The
 * hold exists for the hero — its photograph is the one asset the page is
 * visibly wrong without, and uncovering the page before it has decoded is what
 * makes the product appear to pop in a beat after the site was handed over.
 *
 * ── Why the paint condition exists ──
 *
 * The obvious implementation retires the splash on React's first commit. That
 * is a race, and on WebKit it is a race the splash loses: the node comes out at
 * roughly 125ms while the browser's own first contentful paint lands at ~145ms,
 * so the loader sits in the DOM for the whole load and is never once drawn. The
 * visitor is shown the finished website directly, having seen no loader at all.
 *
 * The margin there is 13-25ms, which is the entire shape of the bug: a race that
 * narrow lands on either side of the line depending on how fast the bundle
 * parsed, so the same phone shows the splash on one load and skips it on the
 * next. A slow exit animation can hide it by accident; take the animation away
 * and it fails identically. It is not a mobile code path — a desktop browser
 * under `prefers-reduced-motion` fails the same way.
 *
 * So the paint is a precondition rather than a side effect, and every readiness
 * signal goes through the same gate whether it resolves from cache in a
 * microtask or from a slow network a second later. Cache state decides how fast
 * the splash leaves; it must never decide whether it was ever there.
 */

/**
 * How long the exit runs before the splash is taken out of the DOM.
 *
 * The paired keyframes in index.css must match: this timer is what removes the
 * node, so a longer animation there would be cut off part-way through.
 *
 * Nothing waits on it — the page underneath is already finished and interactive
 * the moment it starts.
 */
const MORPH_MS = 520;

/**
 * The floor on how long the splash stays up, measured from the frame it was
 * painted on — not from navigation start.
 *
 * Measuring from the paint is what makes this a correctness guarantee rather
 * than a delay. On the ordinary path the hero's hold outlasts it and it costs
 * nothing at all; it only bites when readiness resolved so fast that the splash
 * would otherwise have been removed within a frame or two of appearing, which
 * is a flicker rather than a loading screen.
 *
 * Deliberately small. The answer to an intermittent loader is not a longer
 * arbitrary timeout — a multi-second minimum on a site that has already
 * finished loading is exactly that. 300ms is long enough to register as
 * deliberate and short enough that nobody waits on it.
 */
const MIN_VISIBLE_MS = 300;

/**
 * Backstop on the paint gate itself.
 *
 * `requestAnimationFrame` does not fire in a document the browser is not
 * drawing — a background tab, or a phone whose browser was backgrounded during
 * load. Waiting for a frame that is never coming would wedge the splash on
 * screen for the rest of the session, so the gate opens on its own if no frame
 * has arrived by here. This is a guard against hanging, not a delay: on any
 * document that is actually being drawn, two frames have passed long before it.
 */
const PAINT_GATE_FALLBACK_MS = 400;

/** Why the splash was asked to leave. Recorded, and useful in the debug log. */
export type SplashExitReason =
  | "app-mounted"
  | "hero-ready"
  | "hero-wait-ceiling"
  | "bfcache-restore";

type SplashState = "visible" | "exiting" | "removed";

let state: SplashState = "visible";
/** Outstanding holds. The splash cannot retire while any of these are open. */
let holds = 0;
/** The first reason anything gave for wanting the splash gone, or null. */
let exitRequested: SplashExitReason | null = null;
/** When the splash was confirmed on screen. Null until the gate opens. */
let paintedAt: number | null = null;
/** Timer counting out the remainder of MIN_VISIBLE_MS, if one is running. */
let minVisibleTimer: number | null = null;
/** Timer that takes the node out at the end of the exit, if one is running. */
let removalTimer: number | null = null;

function splashElement(): HTMLElement | null {
  return document.getElementById("boot-splash");
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/* ─── Debug instrumentation ───
   Off unless the URL asks for it, so it costs an ordinary visitor nothing but a
   boolean. Keyed on a query parameter rather than the build mode on purpose:
   the case this has to serve is a real production build open on a physical
   iPhone attached to Safari Web Inspector, where a development bundle is
   exactly what you cannot have. `?splashdebug=1` fills `window.__splashEvents`
   with the ordered lifecycle. */
interface SplashDebugEvent {
  event: string;
  t: number;
  [key: string]: unknown;
}

const debugEnabled = (() => {
  if (typeof window === "undefined") return false;
  try {
    return window.location.search.includes("splashdebug");
  } catch {
    // Location can throw in a sandboxed frame; diagnostics are never worth an
    // exception on the boot path.
    return false;
  }
})();

function log(event: string, extra?: Record<string, unknown>): void {
  if (!debugEnabled) return;
  const store = window as unknown as { __splashEvents?: SplashDebugEvent[] };
  store.__splashEvents ??= [];
  store.__splashEvents.push({
    event,
    t: Math.round(performance.now()),
    state,
    holds,
    ...extra,
  });
}

/* ─── The paint gate ─── */

/**
 * Record that the splash has been on screen, and re-check whether it may now
 * leave. Idempotent: only the first frame counts.
 */
function markPainted(source: string): void {
  if (paintedAt !== null) return;
  paintedAt = performance.now();
  log("splash:first-painted", { source });
  maybeExit();
}

/**
 * Wait for the browser to have drawn a frame containing the splash.
 *
 * Two nested frames, not one. A `requestAnimationFrame` callback runs *before*
 * the paint it belongs to, so a single one proves nothing; the second runs only
 * once the frame the first belonged to has been committed, which is the signal
 * that something was actually put on screen.
 */
function openPaintGateWhenDrawn(): void {
  if (typeof window === "undefined") return;

  // No splash in the document at all — a route served without it, or a test
  // mounting the app into a bare DOM. Nothing to wait for, nothing to protect.
  if (!splashElement()) {
    markPainted("no-splash-element");
    return;
  }

  // A hidden document is not being drawn, and the visitor is not looking at it.
  // Holding a loading screen for a frame that will not arrive until they come
  // back — by which time the site is long finished — is worse than not showing
  // one at all.
  if (document.visibilityState === "hidden") {
    markPainted("document-hidden");
    return;
  }

  requestAnimationFrame(() => requestAnimationFrame(() => markPainted("raf")));
  window.setTimeout(() => markPainted("paint-gate-fallback"), PAINT_GATE_FALLBACK_MS);
}

/* ─── The single exit ─── */

function clearTimers(): void {
  if (minVisibleTimer !== null) {
    window.clearTimeout(minVisibleTimer);
    minVisibleTimer = null;
  }
  if (removalTimer !== null) {
    window.clearTimeout(removalTimer);
    removalTimer = null;
  }
}

/**
 * Whether the page itself may take part in the exit.
 *
 * Scaling #root gives it a transform, and a transformed ancestor becomes the
 * containing block for every `position: fixed` descendant inside it — which
 * here means the site header. At the very top of the document that is
 * invisible, because a header pinned to the top of #root and one pinned to the
 * top of the viewport are in the same place. Anywhere else they are not, and
 * the header would visibly fly up the page for the length of the animation.
 *
 * A visitor who arrived on a deep link, or whose browser restored their scroll
 * position, is exactly that case. They still get the splash animating away; the
 * page underneath simply holds still while it does.
 */
function pageMayMorph(root: HTMLElement | null): root is HTMLElement {
  return root !== null && window.scrollY === 0;
}

/** Take the node out and leave nothing of it behind. The only remover. */
function removeSplash(reason: string): void {
  clearTimers();
  splashElement()?.remove();
  // The class carries `will-change` and leaves a transform on #root. Both would
  // otherwise persist for the life of the page: the first pins a compositing
  // layer for the whole document, and the second keeps #root as the containing
  // block for the fixed header, which breaks it the moment the visitor scrolls.
  document.getElementById("root")?.classList.remove("is-entering");
  state = "removed";
  log("splash:removed", { reason });
}

/**
 * Start the exit. Reached from exactly one place, and never twice.
 *
 * Everything that decides the splash should go — React committing, the hero's
 * image landing, the hero's own wait ceiling — reports that as a request and
 * ends up here once, through the same gate, whether it resolved synchronously
 * from cache or a second later from the network.
 */
function beginExit(reason: SplashExitReason): void {
  if (state !== "visible") return;
  state = "exiting";
  log("splash:exit-start", {
    reason,
    shownForMs: paintedAt === null ? null : Math.round(performance.now() - paintedAt),
  });

  const splash = splashElement();
  if (!splash) {
    removeSplash(reason);
    return;
  }

  // A visitor who asked for less motion gets no exit animation. They still get
  // the loader — it has been on screen for MIN_VISIBLE_MS by the time this runs,
  // which is the whole repair — it simply leaves without a performance.
  if (prefersReducedMotion()) {
    removeSplash(reason);
    return;
  }

  const root = document.getElementById("root");
  if (pageMayMorph(root)) root.classList.add("is-entering");

  // Dropped rather than out-specified. `is-held` only overrides the failsafe's
  // animation-delay, so it sits at the same weight as the exit's own rule and
  // whichever stylesheet loads last would decide the outcome.
  splash.classList.remove("is-held");
  splash.classList.add("is-leaving");

  // Removed rather than left at opacity 0, so it can never trap a click or hold
  // a screen reader on a surface the visitor cannot see.
  removalTimer = window.setTimeout(() => removeSplash(reason), MORPH_MS);
}

/**
 * Re-evaluate every condition. Called whenever any of them changes; does
 * nothing at all until all of them are met.
 */
function maybeExit(): void {
  if (state !== "visible") return;
  if (exitRequested === null) return;
  if (holds > 0) return;
  if (paintedAt === null) return;

  const remaining = MIN_VISIBLE_MS - (performance.now() - paintedAt);
  if (remaining > 0) {
    if (minVisibleTimer === null) {
      log("splash:awaiting-min-visible", { remainingMs: Math.round(remaining) });
      minVisibleTimer = window.setTimeout(() => {
        minVisibleTimer = null;
        maybeExit();
      }, remaining);
    }
    return;
  }

  beginExit(exitRequested);
}

/* ─── Public surface ─── */

/**
 * Ask the splash to leave. Safe to call from anywhere, any number of times, in
 * any order relative to the holds.
 *
 * The first caller's reason is the one recorded; later ones only re-open the
 * question of whether the conditions are now met. Nothing here removes anything
 * directly — that is the point of routing every signal through one controller
 * rather than letting each readiness path retire the splash itself.
 */
export function requestSplashExit(reason: SplashExitReason): void {
  if (state !== "visible") return;
  exitRequested ??= reason;
  log("splash:exit-requested", { reason });
  maybeExit();
}

/**
 * Ask the splash to stay up. Returns the release, which is safe to call more
 * than once and may name the reason the wait ended.
 *
 * Ordering does not matter. The controller holds the request until the holds
 * are clear, so a hold taken late is still honoured — this must never rely on
 * React flushing a child's effects before its parent's.
 */
export function holdSplash(): (reason?: SplashExitReason) => void {
  // Once the splash is gone there is nothing to hold. Without this, a later
  // remount takes a hold on a node that no longer exists and leaves a stray
  // ceiling timer behind it.
  if (state === "removed") return () => {};

  holds += 1;
  log("splash:hold-taken");
  // index.html expires the splash on its own after a few seconds, so a bundle
  // that never runs cannot leave anyone stranded on a branded blank screen.
  // That deadline is far too short for a deliberate hold, so taking one moves
  // the failsafe out to a longer one. It is still a failsafe: the hold's owner
  // is expected to cap itself well inside it.
  splashElement()?.classList.add("is-held");

  let released = false;
  return (reason?: SplashExitReason) => {
    if (released) return;
    released = true;
    holds -= 1;
    log("splash:hold-released", { reason: reason ?? null });
    if (reason) exitRequested ??= reason;
    maybeExit();
  };
}

/**
 * Publish load progress into the splash, 0..1.
 *
 * Written straight to the element's style. The splash is outside the React
 * tree, and this can be called more than once per frame.
 */
export function setSplashProgress(value: number): void {
  if (state === "removed") return;
  const bar = document.getElementById("boot-splash-bar");
  if (!bar) return;
  const clamped = Math.min(1, Math.max(0, value));
  bar.style.transform = `scaleX(${clamped.toFixed(3)})`;
}

/**
 * Retire the splash on React's first commit.
 *
 * Call from a mount effect, not from immediately after `createRoot().render()`.
 * A concurrent root schedules that render rather than performing it, so calling
 * this on the next line asks for the splash while the page underneath is still
 * empty.
 */
export function dismissSplash(): void {
  requestSplashExit("app-mounted");
}

/* ─── Page restoration ───

   Safari restores a bfcached document exactly as it was, without re-running any
   of the boot sequence. Two states are worth correcting on the way back in.

   A document cached *during* boot comes back with the splash still on top of a
   page that has since finished — a stale overlay over a site that is ready. And
   one cached mid-exit comes back with `is-entering` still on #root, which is a
   live transform: it makes #root the containing block for the fixed header, so
   the header detaches from the viewport the moment the visitor scrolls. Neither
   can be reached by waiting, because nothing is running.

   A restore that finds nothing left over — the ordinary case, where the splash
   retired normally before the visitor navigated away — costs one branch and
   changes nothing. The loader is deliberately not replayed: the page is already
   rendered underneath, and a loading screen over finished content is a
   regression, not a feature. */
if (typeof window !== "undefined") {
  window.addEventListener("pageshow", (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    log("page:bfcache-restored");
    if (state === "removed" && !splashElement()) return;
    removeSplash("bfcache-restore");
  });

  openPaintGateWhenDrawn();
}
