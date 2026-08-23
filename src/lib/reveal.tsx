import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { duration, stagger } from "./motion/tokens";

/*
 * Every number here comes from the motion tokens rather than being declared
 * locally. Local copies were the original arrangement and they were wrong on
 * the project's own terms: tokens.ts is meant to be the only file carrying a
 * motion value, and a second set of constants here is exactly the drift that
 * rule exists to prevent — retuning the site's stagger would have silently left
 * the reveal on its old timing.
 */

/** Gap between neighbouring items in a staggered group, in milliseconds. */
const STEP_MS = stagger.item * 1000;

/**
 * Past this many steps the stagger stops growing. A long menu would otherwise
 * leave the last card waiting the better part of a second after the first — the
 * effect stops reading as a flourish and starts reading as the page being slow.
 */
const MAX_STEPS = stagger.maxSteps;

/**
 * How long one element takes to settle.
 *
 * Published to CSS as `--reveal-duration` and read by the `.reveal` transition,
 * and also what the settle timer below counts down. The two drifting apart
 * would either strip the class mid-animation or leave it on long after the
 * element had arrived.
 */
const DURATION_MS = duration.sweep * 1000;

/**
 * One observer for the whole page rather than one per element. A grid can hold
 * many cards, and a separate IntersectionObserver for each is real work on a
 * phone for no benefit.
 */
let observer: IntersectionObserver | null = null;
const pending = new WeakMap<Element, () => void>();

function sharedObserver(): IntersectionObserver | null {
  if (observer) return observer;
  if (typeof IntersectionObserver === "undefined") return null;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const reveal = pending.get(entry.target);
        if (!reveal) continue;
        // Once shown, an element is done — it is never re-hidden, so it is
        // dropped from the observer instead of being watched for the life of
        // the page.
        pending.delete(entry.target);
        observer?.unobserve(entry.target);
        reveal();
      }
    },
    {
      // Fires a little after the element's top edge clears the bottom of the
      // viewport, so the movement happens where it can be seen rather than
      // finishing off-screen.
      rootMargin: "0px 0px -8% 0px",
      threshold: 0.01,
    },
  );
  return observer;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Reveal-on-scroll for an element that already exists in the markup.
 *
 * Returns props to spread onto it rather than wrapping it in anything: the menu
 * cards are grid children, so an extra wrapper element would land between the
 * container and its children and break the layout.
 *
 * Anything already on screen at load — the hero — reveals immediately, because
 * an intersecting element fires the observer on its first callback.
 */
export function useReveal<T extends HTMLElement>(index = 0) {
  const [shown, setShown] = useState(false);
  // Once the animation has played, the element drops out of the effect
  // entirely. See the note below on why that matters.
  const [settled, setSettled] = useState(false);
  const delay = Math.min(index, MAX_STEPS) * STEP_MS;

  /**
   * A callback ref rather than a `useRef` + effect pair. Two reasons: it runs
   * at the moment the node is attached, so nothing is missed if an element
   * mounts already on screen; and it keeps the returned object free of a ref
   * object, which is what lets callers read `className` off it during render.
   */
  const ref = useCallback((node: T | null) => {
    if (!node) return;

    const obs = sharedObserver();
    // No observer support, or the visitor asked for less motion: skip straight
    // to the finished state. Never leave content hidden behind an effect that
    // cannot run.
    if (!obs || prefersReducedMotion()) {
      setShown(true);
      setSettled(true);
      return;
    }

    pending.set(node, () => setShown(true));
    obs.observe(node);
    return () => {
      pending.delete(node);
      obs.unobserve(node);
    };
  }, []);

  /**
   * Strip the reveal once it has finished playing.
   *
   * The class carries a `transition` and a `transition-delay`, and several of
   * the elements being revealed own transitions of their own — a menu card
   * animates its hover lift. Leaving `.reveal` on the element would both
   * override that and make the hover wait out the stagger delay before moving.
   * Since the finished state is identical to the element's natural one,
   * removing the class is invisible and hands every element back its own
   * styling.
   *
   * A timer rather than `transitionend`: that event fires per-property and not
   * at all for an element that never got to animate, which would strand the
   * class on exactly the elements this is meant to protect.
   */
  useEffect(() => {
    if (!shown || settled) return;
    const timer = window.setTimeout(() => setSettled(true), delay + DURATION_MS + 50);
    return () => window.clearTimeout(timer);
  }, [shown, settled, delay]);

  // A tuple, not one object with a `ref` on it. Lint treats every property of
  // an object carrying a ref as a ref read, so `className` could not be looked
  // up during render — which is the one thing this hook exists to provide.
  if (settled) {
    return [ref, { className: "", style: undefined }] as const;
  }

  return [
    ref,
    {
      className: shown ? "reveal is-visible" : "reveal",
      style: {
        "--reveal-delay": `${delay}ms`,
        "--reveal-duration": `${DURATION_MS}ms`,
      } as CSSProperties,
    },
  ] as const;
}

/**
 * Join an element's own classes with the reveal's. The reveal contributes an
 * empty string once it has settled, so this keeps a stray trailing space out of
 * the markup.
 */
export function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * The wrapper form, for the common case where a plain block is being revealed
 * and an extra `<div>` costs nothing.
 */
export default function Reveal({
  children,
  index = 0,
  className = "",
  id,
}: {
  children: ReactNode;
  /** Position within a staggered group. */
  index?: number;
  className?: string;
  id?: string;
}) {
  const [ref, anim] = useReveal<HTMLDivElement>(index);
  return (
    <div ref={ref} id={id} className={cx(className, anim.className)} style={anim.style}>
      {children}
    </div>
  );
}
