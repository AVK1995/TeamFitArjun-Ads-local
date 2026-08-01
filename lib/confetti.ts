/**
 * Physics-based confetti cannon (canvas-confetti).
 *
 * Two cannons fire inward from the left and right screen edges toward the
 * centre, in a short staggered volley, the moment the checkout page opens.
 *
 * canvas-confetti manages its own full-screen, pointer-events-none canvas and
 * the particle physics; this module only supplies the firing parameters and a
 * reduced-motion / SSR guard.
 */
import confetti from "canvas-confetti";

// ── Static config (UPPER_SNAKE_CASE) ────────────────────────────────────────
const CONFETTI_COLORS = [
  "#9A6614", // brand gold
  "#C9954D", // brand light
  "#E9C489", // pale gold
  "#15803D", // success green
  "#2ECC71", // bright green
  "#D99413", // star / amber
  "#B4231D", // danger red
  "#4C9BE8", // blue accent
  "#FBF1DE", // cream
];
const CONFETTI_PARTICLE_COUNT = 60;
const CONFETTI_SPREAD = 62;
const CONFETTI_START_VELOCITY = 58;
const CONFETTI_ORIGIN_Y = 0.62; // a little below vertical centre
const CONFETTI_LEFT_ANGLE = 60; // left cannon fires up-and-right → centre
const CONFETTI_RIGHT_ANGLE = 120; // right cannon fires up-and-left → centre
const CONFETTI_Z_INDEX = 2147483000; // above the sticky bar / any modal
const CONFETTI_VOLLEYS = 3; // staggered bursts for a fuller effect
const CONFETTI_VOLLEY_GAP_MS = 180;

type Edge = "left" | "right";

/** Fire a single cannon from one edge toward the centre. Single-purpose. */
function fireCannon(edge: Edge): void {
  confetti({
    particleCount: CONFETTI_PARTICLE_COUNT,
    angle: edge === "left" ? CONFETTI_LEFT_ANGLE : CONFETTI_RIGHT_ANGLE,
    spread: CONFETTI_SPREAD,
    startVelocity: CONFETTI_START_VELOCITY,
    origin: { x: edge === "left" ? 0 : 1, y: CONFETTI_ORIGIN_Y },
    colors: CONFETTI_COLORS,
    zIndex: CONFETTI_Z_INDEX,
    scalar: 1.05,
    ticks: 220,
    disableForReducedMotion: true,
  });
}

/** Fire both edge cannons once. */
function fireVolley(): void {
  fireCannon("left");
  fireCannon("right");
}

/** Public entry — fire a short staggered volley from both edges. */
export function fireConfetti(): void {
  if (typeof window === "undefined") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  for (let i = 0; i < CONFETTI_VOLLEYS; i++) {
    if (i === 0) fireVolley();
    else window.setTimeout(fireVolley, i * CONFETTI_VOLLEY_GAP_MS);
  }
}
