// The only caller of matchMedia in the interaction layer.
//
// Three questions get asked constantly across the site — does this visitor want
// less motion, are they on a touch device, can they hover — and every component
// that answered them for itself was another place to get the pre-hydration
// guard wrong, another listener, and another chance to forget the preference
// entirely. They are answered once, here, and shared.

import { useSyncExternalStore } from "react";

export interface Capability {
  /** The visitor asked for less motion. Every transform must collapse. */
  reduced: boolean;
  /** Touch or stylus. No hover, no cursor, fingers occlude what they touch. */
  coarse: boolean;
  /** A real hover state exists — mouse or trackpad. */
  canHover: boolean;
}

const QUERIES = {
  reduced: "(prefers-reduced-motion: reduce)",
  coarse: "(pointer: coarse)",
  canHover: "(hover: hover) and (pointer: fine)",
} as const;

/**
 * Pre-hydration default: no motion, no hover, treated as touch.
 *
 * Deliberately the most conservative answer rather than the most common one.
 * If the first render assumes hover and the device turns out to be a phone, the
 * correction is a visible flash of desktop-only chrome; assuming touch and
 * correcting to desktop only adds capability that was not there a frame ago.
 */
const SERVER_SNAPSHOT: Capability = { reduced: true, coarse: true, canHover: false };

function supported(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

/**
 * Cached so that `getSnapshot` returns a referentially stable object between
 * media-query changes. useSyncExternalStore re-renders whenever the snapshot
 * identity differs from the last one, so building a fresh object each call
 * would spin the component in an infinite render loop.
 */
let cached: Capability | null = null;

function readCapability(): Capability {
  if (!supported()) return SERVER_SNAPSHOT;
  const next: Capability = {
    reduced: window.matchMedia(QUERIES.reduced).matches,
    coarse: window.matchMedia(QUERIES.coarse).matches,
    canHover: window.matchMedia(QUERIES.canHover).matches,
  };
  if (
    cached
    && cached.reduced === next.reduced
    && cached.coarse === next.coarse
    && cached.canHover === next.canHover
  ) {
    return cached;
  }
  cached = next;
  return next;
}

/**
 * One listener per query for the whole application, regardless of how many
 * components subscribe. The menu alone mounts several animated cards, and three
 * MediaQueryList listeners each is real work on a phone for an answer that is
 * identical for all of them.
 */
function subscribe(onChange: () => void): () => void {
  if (!supported()) return () => {};
  const lists = Object.values(QUERIES).map((query) => window.matchMedia(query));
  const handler = () => {
    // Drop the cache first: readCapability compares against it to decide
    // whether the snapshot identity may be reused, and a stale hit here would
    // swallow the very change that triggered this callback.
    cached = null;
    onChange();
  };
  for (const list of lists) list.addEventListener("change", handler);
  return () => {
    for (const list of lists) list.removeEventListener("change", handler);
  };
}

/**
 * Live device and preference capabilities.
 *
 * Reactive on purpose: a visitor can turn reduced motion on from the system
 * settings while the page is open, and a 2-in-1 laptop genuinely switches
 * between coarse and fine pointers when its keyboard is folded away. Reading
 * these once on mount left both cases stuck on the wrong answer.
 */
export function useCapability(): Capability {
  return useSyncExternalStore(subscribe, readCapability, () => SERVER_SNAPSHOT);
}

/**
 * Non-reactive read, for imperative code that runs outside React's lifecycle.
 * Components should use the hook so they re-render when the answer changes.
 */
export function readCapabilityOnce(): Capability {
  return readCapability();
}
