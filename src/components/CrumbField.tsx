/**
 * The ingredients orbiting the pan in the hero.
 *
 * Drawn rather than photographed. The reference this hero follows floats
 * cut-out photographs of its toppings around the product, and cut-outs are the
 * right call there because a mushroom is hard to draw convincingly. A chocolate
 * chip is not: it is three tones and a highlight, so a 700-byte inline vector
 * gets closer to the reference than a 40KB masked JPEG would, stays perfectly
 * crisp at any size, and costs no request at the exact moment the hero
 * photograph is already asking for bandwidth.
 *
 * Everything about an ingredient's placement, size and drift lives in ITEMS.
 * The components below only know how to draw one; where it sits and how it
 * moves is data, so adding a chip is a line in an array rather than a new rule
 * in the stylesheet.
 */

import { useCapability } from "@/lib/motion/useCapability";

type Kind = "chunk" | "chip" | "hazelnut" | "almond";

interface Crumb {
  id: string;
  kind: Kind;
  /** Position within the hero box, as a percentage of its width / height. */
  x: number;
  y: number;
  /** Phone-only override. Omitted means "keep the desktop placement". */
  sx?: number;
  sy?: number;
  /** Multiplier on `--crumb-unit`. Keeps every ingredient on one scale. */
  scale: number;
  /** Resting rotation, degrees. */
  tilt: number;
  /** Seconds for one full drift cycle. Deliberately all different — a shared
   *  period makes eight independent objects read as one bobbing sheet. */
  drift: number;
  /** Entrance order. */
  step: number;
  /** Dropped on phones, where the copy needs the middle of the screen. */
  wide?: boolean;
}

/**
 * Positions hug the left and right edges and leave the centre column clear,
 * because the centre column is the headline. The reference does the same thing:
 * every one of its toppings is outside the text block, which is what lets the
 * ingredients be large without competing with anything.
 */
const ITEMS: Crumb[] = [
  { id: "chunk-tl", kind: "chunk", x: 4, y: 26, sx: 11, sy: 13, scale: 1.15, tilt: -14, drift: 7.5, step: 0 },
  { id: "chip-tr", kind: "chip", x: 78, y: 20, scale: 0.66, tilt: 16, drift: 6.2, step: 3, wide: true },
  { id: "hazel-r", kind: "hazelnut", x: 91, y: 33, sx: 89, sy: 14, scale: 0.82, tilt: -8, drift: 8.1, step: 1 },
  { id: "chunk-r", kind: "chunk", x: 95, y: 54, scale: 0.74, tilt: 24, drift: 6.8, step: 4, wide: true },
  { id: "almond-r", kind: "almond", x: 86, y: 70, sx: 90, sy: 70, scale: 0.95, tilt: -34, drift: 7.2, step: 2 },
  { id: "chip-l", kind: "chip", x: 9, y: 68, sx: 8, sy: 67, scale: 0.9, tilt: -22, drift: 6.5, step: 2 },
  { id: "hazel-bl", kind: "hazelnut", x: 1, y: 83, scale: 1.02, tilt: 12, drift: 7.9, step: 5, wide: true },
  { id: "chip-lm", kind: "chip", x: 17, y: 44, scale: 0.5, tilt: 8, drift: 5.8, step: 6, wide: true },
];

/** Milliseconds between neighbouring ingredients arriving. */
const STEP_MS = 90;
/** How long after the pan starts arriving the first ingredient follows. */
const LEAD_MS = 420;

/* ─── The four shapes ─── */

/**
 * A broken block of chocolate: a bevelled top face over two side faces.
 *
 * The three faces are separate paths rather than one shape with a gradient
 * because that is what reads as a solid object — a single silhouette with a
 * soft gradient reads as a sticker. Light is treated as coming from the upper
 * left throughout this file, so the top face is the lightest and the right
 * face the darkest, and every other ingredient agrees with that.
 */
function Chunk({ uid }: { uid: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${uid}-top`} x1="0" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#8B5A2E" />
          <stop offset="0.55" stopColor="#6F4322" />
          <stop offset="1" stopColor="#5A351B" />
        </linearGradient>
        <linearGradient id={`${uid}-left`} x1="0" y1="0" x2="1" y2="0.4">
          <stop offset="0" stopColor="#4A2A14" />
          <stop offset="1" stopColor="#38200F" />
        </linearGradient>
      </defs>
      {/* left / front face */}
      <path d="M13 32 L50 52 L50 88 L13 66 Z" fill={`url(#${uid}-left)`} />
      {/* right face, darkest — it faces away from the light */}
      <path d="M87 30 L50 52 L50 88 L87 64 Z" fill="#2C1810" />
      {/* top face */}
      <path
        d="M13 32 L46 12 Q50 10 54 12 L87 30 L50 52 Z"
        fill={`url(#${uid}-top)`}
      />
      {/* the specular strip along the broken top edge */}
      <path d="M20 32 L47 17 Q50 15.6 53 17 L60 21 L30 37 Z" fill="#A9713C" opacity="0.5" />
    </svg>
  );
}

/**
 * A chip in the classic dropped-cone shape — wide round base, twisted peak.
 * The silhouette is doing all the recognition work here, so it is one path and
 * the shading is two overlays on top of it.
 */
function Chip({ uid }: { uid: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${uid}-body`} cx="0.36" cy="0.3" r="0.85">
          <stop offset="0" stopColor="#6B3F1F" />
          <stop offset="0.5" stopColor="#4A2814" />
          <stop offset="1" stopColor="#2A160B" />
        </radialGradient>
      </defs>
      <path
        d="M11 74c0-15 13-38 28-58 5-7 13-7 18 0 15 20 32 43 32 58 0 12-19 19-39 19S11 86 11 74Z"
        fill={`url(#${uid}-body)`}
      />
      {/* highlight down the lit face */}
      <path
        d="M31 66c1-13 9-29 17-41 3-4 7-4 7 1-6 13-13 28-15 42-1 7-10 5-9-2Z"
        fill="#A9713C"
        opacity="0.42"
      />
      {/* the base sits in its own shadow */}
      <ellipse cx="50" cy="86" rx="33" ry="7" fill="#1E0F07" opacity="0.35" />
    </svg>
  );
}

/** A hazelnut: sphere, papery cap at the base, blunt tip at the top. */
function Hazelnut({ uid }: { uid: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${uid}-shell`} cx="0.34" cy="0.28" r="0.82">
          <stop offset="0" stopColor="#C98A4B" />
          <stop offset="0.45" stopColor="#A2662F" />
          <stop offset="1" stopColor="#6B3E18" />
        </radialGradient>
        <radialGradient id={`${uid}-cap`} cx="0.4" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#9C7A4E" />
          <stop offset="1" stopColor="#6A4C2A" />
        </radialGradient>
      </defs>
      <path
        d="M50 8c4 0 6 4 7 9 14 5 25 19 25 36 0 22-15 39-32 39S18 75 18 53c0-17 11-31 25-36 1-5 3-9 7-9Z"
        fill={`url(#${uid}-shell)`}
      />
      {/* the cap — a scalloped disc where the nut sat in its husk */}
      <path
        d="M50 92c-12 0-22-7-26-17 7 6 16 9 26 9s19-3 26-9c-4 10-14 17-26 17Z"
        fill={`url(#${uid}-cap)`}
      />
      <ellipse cx="37" cy="38" rx="11" ry="15" fill="#E4B37A" opacity="0.34" transform="rotate(-18 37 38)" />
    </svg>
  );
}

/** An almond: pointed oval with the seam down its face. */
function Almond({ uid }: { uid: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${uid}-nut`} x1="0.2" y1="0.1" x2="0.85" y2="0.95">
          <stop offset="0" stopColor="#E8C99A" />
          <stop offset="0.5" stopColor="#CDA271" />
          <stop offset="1" stopColor="#9E7343" />
        </linearGradient>
      </defs>
      <path
        d="M50 6c17 0 31 22 31 46S67 94 50 94 19 76 19 52 33 6 50 6Z"
        fill={`url(#${uid}-nut)`}
      />
      <path d="M50 14c-4 16-5 42 0 72" stroke="#8A6236" strokeWidth="2.4" fill="none" opacity="0.5" />
      <path
        d="M39 26c-5 10-7 22-6 34"
        stroke="#F3DEBB"
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
        opacity="0.55"
      />
    </svg>
  );
}

const SHAPES: Record<Kind, (props: { uid: string }) => React.JSX.Element> = {
  chunk: Chunk,
  chip: Chip,
  hazelnut: Hazelnut,
  almond: Almond,
};

/**
 * @param armed Entrance runs once the hero says the page is ready, so the
 *   ingredients do not play their arrival behind the boot splash and then be
 *   already settled by the time the visitor first sees the page.
 */
export default function CrumbField({ armed }: { armed: boolean }) {
  const { reduced } = useCapability();

  return (
    // aria-hidden and not focusable: this is scenery. A screen reader listing
    // eight unlabelled graphics between the headline and the call to action is
    // strictly worse than silence.
    <div className="crumb-field" aria-hidden="true">
      {ITEMS.map((item) => {
        const Shape = SHAPES[item.kind];
        return (
          <span
            key={item.id}
            className={`crumb ${item.wide ? "crumb-wide" : ""} ${armed ? "is-in" : ""}`}
            style={
              {
                "--crumb-x": `${item.x}%`,
                "--crumb-y": `${item.y}%`,
                ...(item.sx === undefined ? null : { "--crumb-x-sm": `${item.sx}%` }),
                ...(item.sy === undefined ? null : { "--crumb-y-sm": `${item.sy}%` }),
                "--crumb-scale": item.scale,
                "--crumb-tilt": `${item.tilt}deg`,
                // Reduced motion keeps the arrival (as a fade) and drops the
                // endless drift entirely. A permanent loop is the part of this
                // that the preference is actually about.
                "--crumb-drift": reduced ? "0s" : `${item.drift}s`,
                // A negative delay starts the loop already part-way through.
                // Without it all eight begin their first cycle at the same
                // instant and the differing periods only pull them apart over
                // the following half minute — so the one moment the visitor is
                // actually watching is the one moment they move in lockstep.
                "--crumb-phase": `-${(item.step * 0.9 + item.drift * 0.13).toFixed(2)}s`,
                "--crumb-delay": `${LEAD_MS + item.step * STEP_MS}ms`,
              } as React.CSSProperties
            }
          >
            <Shape uid={item.id} />
          </span>
        );
      })}
    </div>
  );
}
