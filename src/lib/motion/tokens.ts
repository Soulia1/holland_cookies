// The only file in the site that is allowed to contain a motion number.
//
// Every duration, easing curve, spring and travel distance the interaction
// layer uses lives here. Components import the token, never the literal — so
// the whole site's feel can be retuned from one file, and a value can't drift
// out of step with the twelve other places that were supposed to match it.
//
// The CSS side of the same problem is solved by publishing these as custom
// properties (see `motionCssVars`), so a stylesheet rule and a Framer Motion
// transition that are meant to feel identical genuinely are.

import type { Transition } from "framer-motion";

/**
 * Durations, in seconds — Framer's unit, not CSS's.
 *
 * The scale is deliberately coarse. Four values covering everything from a
 * hover tint to a modal is what stops the site feeling like a dozen different
 * people animated it: anything that moves picks the nearest rung rather than
 * inventing 0.27s because it looked about right in isolation.
 */
export const duration = {
  /** Colour and opacity changes the eye should not have to wait on. */
  instant: 0.12,
  /** The default. Presses, hovers, small transforms. */
  quick: 0.22,
  /** Panels, sheets, anything crossing a meaningful distance. */
  glide: 0.42,
  /** Full-surface changes: modals, hero-scale reveals. */
  sweep: 0.7,
} as const;

/**
 * Easing curves as cubic-bezier control points.
 *
 * `out` is the workhorse — a strong ease-out is what reads as "responsive",
 * because the element covers most of its distance in the first third and the
 * tail is just settling. Symmetric curves feel mechanical on anything the user
 * initiated, and are reserved for motion the page starts by itself.
 */
export const ease = {
  /** expo-out. Departure is instant, arrival is soft. */
  out: [0.16, 1, 0.3, 1],
  /** Slight overshoot. For something arriving that should feel physical. */
  overshoot: [0.34, 1.56, 0.64, 1],
  /** Symmetric. Page-initiated motion only — never a response to input. */
  inOut: [0.65, 0, 0.35, 1],
  /** No character at all. Progress bars, scrubbing, anything linear by nature. */
  linear: [0, 0, 1, 1],
} as const;

/**
 * Spring configurations, for motion that should feel like it has mass.
 *
 * Springs rather than durations wherever the user is directly manipulating
 * something — a press, a drag. A duration-based tween always takes the same
 * time regardless of how far it has to travel, which is exactly wrong when the
 * distance is set by where the finger happens to be.
 */
export const spring = {
  /** Press feedback. Tight, barely any wobble. */
  press: { type: "spring", stiffness: 420, damping: 32, mass: 0.7 },
  /** Sheets and modals. Enough give to read as physical, not bouncy. */
  panel: { type: "spring", stiffness: 260, damping: 30, mass: 0.9 },
  /** Badges, counters, anything that should pop when it changes. */
  pop: { type: "spring", stiffness: 600, damping: 18, mass: 0.6 },
} as const satisfies Record<string, Transition>;

/**
 * Travel distances in pixels.
 *
 * Reveal motion is short on purpose. The instinct is to slide content a long
 * way so the animation is noticeable, but a 60px rise on every card is what
 * makes a page feel like it is assembling itself under the reader. 16-24px
 * reads as the content settling; beyond about 32px it reads as a slideshow.
 */
export const travel = {
  /** The drop on a press. */
  nudge: 2,
  /** Standard reveal distance for text and cards. */
  rise: 18,
  /** Panel entry offset before it springs into place. */
  panel: 40,
} as const;

/** Stagger between neighbouring items in a group, in seconds. */
export const stagger = {
  /** Cards in a grid, rows in a list. */
  item: 0.06,
  /** Words in a revealed heading. Tighter — a sentence must stay readable. */
  word: 0.03,
  /**
   * Past this many steps the stagger stops growing. A long menu would
   * otherwise leave the last card waiting most of a second behind the first, at
   * which point the effect stops reading as a flourish and starts reading as
   * the page being slow.
   */
  maxSteps: 6,
} as const;

/**
 * The reduced-motion substitute for any transition.
 *
 * Not zero duration — a hard cut is its own kind of jarring, and the point of
 * the preference is to remove *movement*, not feedback. A fast opacity fade
 * keeps state changes legible while removing every transform. Components get
 * this by calling `transitionFor()` rather than by each remembering to check.
 */
export const reducedTransition: Transition = {
  duration: duration.instant,
  ease: ease.linear,
};

/**
 * Resolve a transition against the visitor's motion preference.
 *
 * The single choke point for `prefers-reduced-motion` in the animation layer.
 * A component cannot forget to honour the preference, because the only
 * supported way to get a transition is through here.
 */
export function transitionFor(preferred: Transition, reduced: boolean): Transition {
  return reduced ? reducedTransition : preferred;
}

/**
 * Distance an element should travel, given the motion preference.
 *
 * Reduced motion collapses every transform to zero while leaving the opacity
 * change intact, so a reveal still marks that something arrived.
 */
export function travelFor(distance: number, reduced: boolean): number {
  return reduced ? 0 : distance;
}

/**
 * The same tokens as CSS custom properties, for rules that stay in the
 * stylesheet — the boot splash, the reveal, and anything else that has to
 * animate before React has mounted.
 *
 * Written onto <html> once, by MotionVars.
 */
export function motionCssVars(): Record<string, string> {
  const bezier = (curve: readonly number[]) => `cubic-bezier(${curve.join(", ")})`;
  return {
    "--motion-instant": `${duration.instant}s`,
    "--motion-quick": `${duration.quick}s`,
    "--motion-glide": `${duration.glide}s`,
    "--motion-sweep": `${duration.sweep}s`,
    "--motion-ease-out": bezier(ease.out),
    "--motion-ease-overshoot": bezier(ease.overshoot),
    "--motion-ease-in-out": bezier(ease.inOut),
    "--motion-rise": `${travel.rise}px`,
  };
}
