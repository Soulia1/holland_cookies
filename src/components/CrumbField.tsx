/**
 * The ingredients orbiting the pan in the hero.
 *
 * Drawn rather than photographed. The reference this hero follows floats
 * cut-out photographs of its toppings around the product, and cut-outs are the
 * right call there because a mushroom is hard to draw convincingly. A chocolate
 * chip is not, so a small inline vector gets closer to the reference than a
 * masked JPEG would, stays perfectly crisp at any size, and costs no request at
 * the exact moment the hero photograph is already asking for bandwidth.
 *
 * Every shape below is lit from the upper left and built the same way, because
 * that consistency is what stops eight drawings reading as eight stickers:
 *
 *   1. a silhouette that is slightly irregular — nothing in a kitchen is
 *      symmetrical, and a mirror-perfect outline is the single strongest tell
 *      that something was drawn rather than photographed;
 *   2. a body gradient running light (upper left) to dark (lower right);
 *   3. a diffuse highlight where the light actually lands;
 *   4. a small hard specular dot, the thing that makes a surface read as glossy
 *      chocolate rather than matte plastic;
 *   5. a rim light along the shadow edge — bounce off the cream page — which is
 *      what separates the object from the background without an outline;
 *   6. a contact shadow inside the silhouette at the bottom.
 *
 * Everything about an ingredient's placement, size and drift lives in ITEMS.
 * The components only know how to draw one; where it sits and how it moves is
 * data, so adding a chip is a line in an array rather than a rule in the
 * stylesheet.
 */

import { useCapability } from "@/lib/motion/useCapability";

type Kind = "chunk" | "chip" | "hazelnut" | "almond" | "shard";

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
  { id: "shard-r", kind: "shard", x: 95, y: 54, scale: 0.86, tilt: 24, drift: 6.8, step: 4, wide: true },
  { id: "almond-r", kind: "almond", x: 86, y: 70, sx: 90, sy: 70, scale: 0.95, tilt: -34, drift: 7.2, step: 2 },
  { id: "chip-l", kind: "chip", x: 9, y: 68, sx: 8, sy: 67, scale: 0.9, tilt: -22, drift: 6.5, step: 2 },
  { id: "hazel-bl", kind: "hazelnut", x: 1, y: 83, scale: 1.02, tilt: 12, drift: 7.9, step: 5, wide: true },
  { id: "chip-lm", kind: "chip", x: 17, y: 44, scale: 0.5, tilt: 8, drift: 5.8, step: 6, wide: true },
];

/** Milliseconds between neighbouring ingredients arriving. */
const STEP_MS = 90;
/** How long after the pan starts arriving the first ingredient follows. */
const LEAD_MS = 420;

/* ─── The five shapes ─── */

/**
 * A broken block of chocolate: a bevelled top face over two side faces.
 *
 * Three separate faces rather than one silhouette with a gradient. A single
 * shape reads as a sticker no matter how good the gradient is, because what
 * says "solid" is the hard value break at an edge, not the shading within a
 * face. The top edge is deliberately not straight — this is a piece snapped off
 * a bar, so the break is chipped.
 */
function Chunk({ uid }: { uid: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${uid}-top`} x1="0.1" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#9C6634" />
          <stop offset="0.45" stopColor="#7A4A25" />
          <stop offset="1" stopColor="#5C361A" />
        </linearGradient>
        <linearGradient id={`${uid}-left`} x1="0" y1="0.1" x2="1" y2="0.9">
          <stop offset="0" stopColor="#54301A" />
          <stop offset="1" stopColor="#3A2210" />
        </linearGradient>
        <linearGradient id={`${uid}-right`} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#331D0D" />
          <stop offset="1" stopColor="#221207" />
        </linearGradient>
      </defs>

      {/* left face, catching a little of the light */}
      <path d="M12 33 L50 53 L50 89 L12 67 Z" fill={`url(#${uid}-left)`} />
      {/* right face, turned away from it */}
      <path d="M88 31 L50 53 L50 89 L88 65 Z" fill={`url(#${uid}-right)`} />
      {/* top face — the snapped edge, stepped rather than ruled */}
      <path
        d="M12 33 L30 22 L38 25 L47 13 Q50 11 53 13 L62 19 L72 17 L88 31 L50 53 Z"
        fill={`url(#${uid}-top)`}
      />
      {/* diffuse light across the top face */}
      <path d="M18 33 L46 17 Q50 15 54 17 L64 23 L36 40 Z" fill="#C08A4E" opacity="0.42" />
      {/* specular: small, hard, and off to one side. This is the whole
          difference between glossy chocolate and brown plastic. */}
      <path d="M27 31 L44 21 L49 24 L32 34 Z" fill="#E7BE8C" opacity="0.5" />
      {/* bounce off the page along the shadow edge */}
      <path d="M50 89 L88 65 L88 69 L50 92 Z" fill="#8A5A30" opacity="0.35" />
      <path d="M12 63 L50 85 L50 89 L12 67 Z" fill="#7A4A28" opacity="0.28" />
    </svg>
  );
}

/**
 * A chip in the classic dropped-cone shape — wide round base, twisted peak.
 *
 * The peak leans, because a real chip is extruded and cut and no two are alike;
 * a symmetrical cone is the giveaway.
 */
function Chip({ uid }: { uid: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${uid}-body`} cx="0.34" cy="0.26" r="0.9">
          <stop offset="0" stopColor="#7A4A24" />
          <stop offset="0.42" stopColor="#54301A" />
          <stop offset="0.82" stopColor="#331C0D" />
          <stop offset="1" stopColor="#26150A" />
        </radialGradient>
        <linearGradient id={`${uid}-sheen`} x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" stopColor="#D2A167" stopOpacity="0.85" />
          <stop offset="1" stopColor="#D2A167" stopOpacity="0" />
        </linearGradient>
      </defs>

      <path
        d="M11 73c0-14 11-35 25-55 4-6 9-9 14-8 5 1 7 6 10 12 12 21 29 41 29 52 0 12-19 19-39 19S11 85 11 73Z"
        fill={`url(#${uid}-body)`}
      />
      {/* the lit face, running up the twist to the peak */}
      <path
        d="M30 68c1-13 8-29 16-42 3-5 8-7 9-2-6 14-13 29-15 44-1 7-11 7-10 0Z"
        fill={`url(#${uid}-sheen)`}
      />
      {/* specular */}
      <ellipse cx="41" cy="38" rx="4.5" ry="9" fill="#F0CB9B" opacity="0.5" transform="rotate(-22 41 38)" />
      {/* rim light down the shadow side */}
      <path
        d="M79 62c4 6 6 10 6 13 0 4-2 7-6 9 2-7 1-15-4-24Z"
        fill="#8A5A30"
        opacity="0.5"
      />
      {/* the base sits in its own shadow */}
      <ellipse cx="50" cy="86" rx="32" ry="7" fill="#180C05" opacity="0.4" />
    </svg>
  );
}

/**
 * A hazelnut: near-spherical, with the pale scalloped cap where it sat in its
 * husk and the fine vertical striations down the shell.
 *
 * Rounder than instinct suggests. An egg with a point on top is an acorn, and
 * the difference between the two is almost entirely how blunt the tip is.
 */
function Hazelnut({ uid }: { uid: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${uid}-shell`} cx="0.33" cy="0.27" r="0.85">
          <stop offset="0" stopColor="#D2924F" />
          <stop offset="0.42" stopColor="#A9682C" />
          <stop offset="0.85" stopColor="#71431A" />
          <stop offset="1" stopColor="#5A3413" />
        </radialGradient>
        <radialGradient id={`${uid}-cap`} cx="0.42" cy="0.25" r="0.85">
          <stop offset="0" stopColor="#C4A87C" />
          <stop offset="1" stopColor="#7A5C34" />
        </radialGradient>
      </defs>

      {/* body: a sphere with the faintest nib at the top */}
      <path
        d="M50 9c3 0 5 3 6 7 15 5 26 20 26 38 0 22-14 38-32 38S18 76 18 54c0-18 11-33 26-38 1-4 3-7 6-7Z"
        fill={`url(#${uid}-shell)`}
      />
      {/* striations — barely there, but they are what says "shell" */}
      <g stroke="#5E3616" strokeWidth="1.6" fill="none" opacity="0.28" strokeLinecap="round">
        <path d="M38 24c-4 16-5 34-2 50" />
        <path d="M50 20c-2 18-2 36 0 54" />
        <path d="M62 24c4 16 5 34 2 50" />
      </g>
      {/* diffuse light */}
      <ellipse cx="38" cy="38" rx="12" ry="16" fill="#EBBF84" opacity="0.32" transform="rotate(-18 38 38)" />
      {/* specular */}
      <ellipse cx="35" cy="32" rx="4" ry="6" fill="#FBE6C6" opacity="0.55" transform="rotate(-22 35 32)" />
      {/* the cap, scalloped where the husk gripped it */}
      <path
        d="M50 93c-13 0-24-8-28-19 3 3 7 5 10 3 3 4 7 5 10 3 3 4 8 5 11 2 3 4 8 4 11 1 3 3 7 2 10-2-3 8-12 12-24 12Z"
        fill={`url(#${uid}-cap)`}
      />
      {/* bounce along the bottom edge */}
      <path d="M23 70c6 12 16 19 27 19s21-7 27-19c-3 16-15 25-27 25S26 86 23 70Z" fill="#B87C42" opacity="0.22" />
    </svg>
  );
}

/** An almond: pointed teardrop, pale, with the grain running from the tip. */
function Almond({ uid }: { uid: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${uid}-nut`} x1="0.22" y1="0.08" x2="0.86" y2="0.95">
          <stop offset="0" stopColor="#F0D7AB" />
          <stop offset="0.45" stopColor="#D2A876" />
          <stop offset="1" stopColor="#96683A" />
        </linearGradient>
      </defs>

      {/* Not a symmetrical oval: one shoulder is fuller than the other. */}
      <path
        d="M50 5c9 1 18 12 24 27 5 13 6 28 2 39-4 12-14 24-26 24s-22-12-26-24c-4-11-3-26 2-39C32 17 41 6 50 5Z"
        fill={`url(#${uid}-nut)`}
      />
      {/* grain, fanning out from the tip */}
      <g stroke="#9E7444" strokeWidth="1.5" fill="none" opacity="0.38" strokeLinecap="round">
        <path d="M50 13c-6 20-8 46-4 74" />
        <path d="M50 13c4 20 7 46 4 74" />
        <path d="M42 22c-7 18-10 42-7 62" />
      </g>
      {/* diffuse light down the lit shoulder */}
      <path
        d="M40 24c-6 11-9 25-8 38 0 5-7 5-7-1 0-15 4-29 10-40 3-5 8-2 5 3Z"
        fill="#FBEDD2"
        opacity="0.55"
      />
      {/* specular */}
      <ellipse cx="40" cy="30" rx="3.4" ry="7" fill="#FFF8EA" opacity="0.6" transform="rotate(-16 40 30)" />
      {/* the shadow edge, warmed by bounce off the page */}
      <path d="M72 40c5 13 5 28 0 39-4 9-11 16-19 16 12-6 20-19 22-35 1-7 0-14-3-20Z" fill="#B98A56" opacity="0.4" />
    </svg>
  );
}

/**
 * A thin shard snapped off a bar — the flat, angular counterpoint to the chunk.
 *
 * Almost all silhouette: it is thin enough that the faces barely show, so what
 * has to carry it is a convincing broken edge and one hard sheen streak.
 */
function Shard({ uid }: { uid: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${uid}-face`} x1="0.1" y1="0.1" x2="0.9" y2="0.9">
          <stop offset="0" stopColor="#8E5C2C" />
          <stop offset="0.5" stopColor="#5F381B" />
          <stop offset="1" stopColor="#3A210F" />
        </linearGradient>
      </defs>

      {/* the flat top face, snapped along the lower left */}
      <path d="M16 40 L58 12 L88 30 L74 62 L34 74 Z" fill={`url(#${uid}-face)`} />
      {/* thickness, seen along the two near edges */}
      <path d="M16 40 L34 74 L34 82 L16 48 Z" fill="#2A1709" />
      <path d="M34 74 L74 62 L74 70 L34 82 Z" fill="#221207" />
      {/* sheen streak across the face */}
      <path d="M27 40 L57 20 L67 26 L37 47 Z" fill="#C08A4E" opacity="0.4" />
      <path d="M33 40 L56 25 L60 28 L37 43 Z" fill="#EDC895" opacity="0.45" />
      {/* bounce along the bottom edge */}
      <path d="M34 78 L74 66 L74 70 L34 82 Z" fill="#8A5A30" opacity="0.4" />
    </svg>
  );
}

const SHAPES: Record<Kind, (props: { uid: string }) => React.JSX.Element> = {
  chunk: Chunk,
  chip: Chip,
  hazelnut: Hazelnut,
  almond: Almond,
  shard: Shard,
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
