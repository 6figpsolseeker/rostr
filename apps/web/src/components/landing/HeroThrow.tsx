"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

/**
 * The football thrown across the hero, whose flight path becomes the rule under
 * the headline.
 *
 * ## What is actually happening
 *
 * One quadratic Bézier from `P0` through control `C` to `P1`. On each frame the
 * ball sits at `B(t)` and the *visible* path is the curve up to `t`, obtained by
 * a single de Casteljau split — control `m0 = lerp(P0, C, t)`, endpoint `B(t)`.
 * That split is the whole effect: without it the full arc is drawn from the
 * first frame and the ball merely travels along a line that is already there.
 * With it, the line is drawn *by* the ball.
 *
 * When the flight completes, a second tween eases the six path numbers from the
 * curve to a straight rule. The resting line is **measured** from the underline
 * slot rather than computed as a fraction of hero height — the headline rewraps
 * at every breakpoint and a fraction drifts every time it does.
 *
 * ## Two things that look like mistakes and are not
 *
 * The resting path ends half a pixel below where it starts. A perfectly
 * horizontal path has a zero-area bounding box, and SVG will not paint an
 * `objectBoundingBox` gradient onto one — the rule simply vanishes at the moment
 * it settles.
 *
 * The underline slot is a zero-width spacer that never grows. It exists so the
 * headline block reserves the space the rule lands in; delete it and the
 * paragraph shifts up by 27px the instant the animation ends.
 *
 * ## Why it is imperative
 *
 * The path is driven through refs inside `requestAnimationFrame`, deliberately
 * outside React state. Sixty state updates a second to animate six numbers would
 * re-render the whole hero on every frame, and the animation has to survive
 * re-renders it does not cause.
 */

/** Variant A of the two the design shipped: the shorter, contained throw. */
const DURATION_MS = 950;
const START_DELAY_MS = 260;
const MORPH_MS = 520;
const SPINS = 3.4;
const RESTING_WIDTH = 470;

/** Shown once per visitor. A landing page replayed on every visit is a tic. */
const SEEN_KEY = "rostr:hero-throw-seen";

interface Point {
  readonly x: number;
  readonly y: number;
}

const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** A quadratic Bézier, as an SVG path command. */
const pathOf = (p0: Point, c: Point, p1: Point): string =>
  `M ${p0.x} ${p0.y} Q ${c.x} ${c.y} ${p1.x} ${p1.y}`;

export function HeroThrow({
  headline,
  children,
}: {
  /** Tag and h1. The rule comes to rest directly beneath this. */
  readonly headline: ReactNode;
  /** Everything below the rule: paragraph, buttons, meta. */
  readonly children: ReactNode;
}) {
  const hero = useRef<HTMLDivElement>(null);
  const path = useRef<SVGPathElement>(null);
  const ball = useRef<HTMLDivElement>(null);
  const underline = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const heroEl = hero.current;
    const pathEl = path.current;
    const ballEl = ball.current;
    const underlineEl = underline.current;
    if (!heroEl || !pathEl || !ballEl || !underlineEl) return;

    /** Where the rule comes to rest, measured rather than assumed. */
    const restingLine = (): { from: Point; to: Point } => {
      const y = underlineEl.offsetTop + 0.5;
      const width = Math.min(RESTING_WIDTH, heroEl.clientWidth - 4);
      // Ends 0.5px lower than it starts: a zero-area bounding box takes no
      // `objectBoundingBox` gradient, and the rule would disappear.
      return { from: { x: 2, y }, to: { x: 2 + width, y: y + 0.5 } };
    };

    const settle = (): void => {
      const { from, to } = restingLine();
      pathEl.setAttribute("d", pathOf(from, lerp(from, to, 0.5), to));
      ballEl.style.opacity = "0";
    };

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let seen = false;
    try {
      seen = window.localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      // Private browsing, or storage disabled. Playing the animation is the
      // harmless outcome, so this is not worth surfacing.
    }

    if (reduced || seen) {
      settle();
      const onResize = (): void => settle();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }

    let frame = 0;
    let cancelled = false;

    const start = window.setTimeout(() => {
      if (cancelled) return;

      const w = heroEl.clientWidth;
      const h = heroEl.clientHeight;
      const p0: Point = { x: -30, y: h * 0.62 };
      const c: Point = { x: w * 0.5, y: h * 0.02 };
      const p1: Point = { x: w + 20, y: h * 0.4 };

      const began = performance.now();

      const flight = (now: number): void => {
        const t = Math.min(1, (now - began) / DURATION_MS);
        const m0 = lerp(p0, c, t);
        const at = lerp(m0, lerp(c, p1, t), t);

        pathEl.setAttribute("d", pathOf(p0, m0, at));
        ballEl.style.transform = `translate(${at.x - 23}px, ${at.y - 14.5}px) rotate(${t * 360 * SPINS}deg)`;

        if (t < 1) {
          frame = requestAnimationFrame(flight);
          return;
        }

        // The morph: six numbers eased from the flight curve to the rule.
        const rest = restingLine();
        const fromPts: Point[] = [p0, m0, at];
        const toPts: Point[] = [rest.from, lerp(rest.from, rest.to, 0.5), rest.to];
        const morphBegan = performance.now();

        const morph = (tick: number): void => {
          const k = Math.min(1, (tick - morphBegan) / MORPH_MS);
          const eased = 1 - (1 - k) ** 3;
          const [a, b, d] = fromPts.map((point, i) => lerp(point, toPts[i]!, eased)) as [
            Point,
            Point,
            Point,
          ];

          pathEl.setAttribute("d", pathOf(a, b, d));
          ballEl.style.opacity = String(1 - eased);

          if (k < 1) {
            frame = requestAnimationFrame(morph);
            return;
          }
          try {
            window.localStorage.setItem(SEEN_KEY, "1");
          } catch {
            // As above.
          }
        };

        frame = requestAnimationFrame(morph);
      };

      frame = requestAnimationFrame(flight);
    }, START_DELAY_MS);

    // Only after the throw has settled — recomputing mid-flight would snap the
    // ball to a curve it is not on.
    const onResize = (): void => {
      if (ballEl.style.opacity === "0") settle();
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      window.clearTimeout(start);
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div ref={hero} className="relative min-h-[420px] px-10 pt-24">
      <svg
        className="pointer-events-none absolute inset-0 z-[1] h-full w-full overflow-visible"
        aria-hidden="true"
      >
        <defs>
          {/*
            Default `objectBoundingBox` units, so the rule fades at both ends at
            whatever length it happens to be — no recalculation on resize.
          */}
          <linearGradient id="rostrArc">
            <stop offset="0%" stopColor="#9184d9" stopOpacity="0" />
            <stop offset="18%" stopColor="#9184d9" stopOpacity="0.9" />
            <stop offset="82%" stopColor="#9184d9" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#9184d9" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path ref={path} fill="none" stroke="url(#rostrArc)" strokeWidth="1" d="" />
      </svg>

      <div
        ref={ball}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 z-[3] flex h-[29px] w-[46px] items-center justify-center rounded-[50%]"
        style={{
          background:
            "radial-gradient(ellipse at 32% 26%, #96603f 0%, #6d4028 46%, #402415 100%)",
          boxShadow: "inset 0 -3px 6px rgba(0,0,0,0.5), 0 0 22px rgba(145,132,217,0.35)",
        }}
      >
        <div className="flex h-[2px] w-[17px] justify-between bg-nocturne-neutral-200">
          {[0, 1, 2, 3].map((tick) => (
            <span
              key={tick}
              className="h-[6px] w-[1.5px] -translate-y-[2px] bg-nocturne-neutral-200"
            />
          ))}
        </div>
      </div>

      <div className="relative z-[2] max-w-[760px]">
        {headline}
        {/*
          The spacer the rule lands on, between the headline and the body — which
          is where the design puts it and why it is a slot rather than a trailing
          element. Never grows; see the module docstring.
        */}
        <div ref={underline} className="mt-[26px] h-px w-0" />
        {children}
      </div>
    </div>
  );
}
