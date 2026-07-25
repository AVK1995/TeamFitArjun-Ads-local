import { UtmCapture } from "@/components/UtmCapture";
import { buildMetadata } from "@/lib/seo";
import { getVimeoPoster } from "@/lib/vimeo";
import { ThankYouView } from "./ThankYouView";
import "./thankyou.css";

export const dynamic = "force-static";
export const metadata = buildMetadata("thankYou");

/** Vimeo id for the thank-you video — keep in step with HERO_VIDEO_URL in ThankYouView. */
const HERO_VIDEO_ID = "1212886807";
/** Used only if Vimeo is unreachable at build time. */
const POSTER_FALLBACK = "/Thank%20you%20page%20video%20thumbnail.png";

export default async function ThankYouPage() {
  // Resolved at build time and inlined into the static HTML.
  const posterUrl = await getVimeoPoster(HERO_VIDEO_ID, POSTER_FALLBACK);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: PAGE_OVERRIDES }} />
      <UtmCapture />
      <ThankYouView posterUrl={posterUrl} />
    </>
  );
}

/**
 * Per-page overrides on top of the source CSS.
 *
 *  1. Match the hero play button to the landing page's `.af-play` look:
 *     gold radial-gradient body, pulsing ring shadow, hover scale + glow,
 *     same 88px desktop / 60px mobile sizing.
 *
 *  2. Mobile-only spacing tweaks for the quiz modal so the eyebrow + title
 *     aren't pinned against the top edge of the screen.
 *
 *  3. Locked "Form Submitted Successfully" state for the quiz CTAs.
 */
const PAGE_OVERRIDES = `
/* Hero play button — replicate landing's .af-play visual on .ty-vplay */
.af-root .ty-vplay {
  width: 88px !important;
  height: 88px !important;
  background: radial-gradient(
    circle at 30% 30%,
    var(--brand-light, #C9954D) 0%,
    var(--brand, #9A6614) 60%,
    var(--brand-deep, #7C5210) 100%
  ) !important;
  animation: tyPlayPulseGold 2.2s infinite ease-out !important;
  transition: transform .25s cubic-bezier(.4, 0, .2, 1) !important;
  cursor: pointer;
  will-change: transform, box-shadow;
}
.af-root .ty-vplay::before {
  content: "";
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  pointer-events: none;
  background: radial-gradient(circle, rgba(255, 255, 255, .18), transparent 70%);
  opacity: 0;
  transition: opacity .25s;
}
.af-root .ty-vplay:hover::before { opacity: 1; }
.af-root .ty-vplay:hover {
  transform: translate(-50%, -50%) scale(1.08) !important;
}
.af-root .ty-vplay:active {
  transform: translate(-50%, -50%) scale(1.02) !important;
  transition-duration: .08s !important;
}
.af-root .ty-vplay svg {
  width: 30px !important;
  height: 30px !important;
  margin-left: 4px !important;
}
@keyframes tyPlayPulseGold {
  0%   { box-shadow: 0 0 0 0   rgba(201, 149, 77, .4); }
  70%  { box-shadow: 0 0 0 30px rgba(201, 149, 77, 0); }
  100% { box-shadow: 0 0 0 0   rgba(201, 149, 77, 0); }
}
@media (max-width: 640px) {
  .af-root .ty-vplay {
    width: 60px !important;
    height: 60px !important;
  }
  .af-root .ty-vplay svg {
    width: 22px !important;
    height: 22px !important;
  }
}

/* "Form Submitted Successfully" locked state */
.af-root .ty-quiz-trigger-done {
  background: linear-gradient(180deg, rgba(34, 197, 94, .9) 0%, rgba(22, 163, 74, .9) 100%) !important;
  cursor: default !important;
  box-shadow: 0 4px 14px rgba(34, 197, 94, .25), inset 0 1px 0 rgba(255, 255, 255, .2) !important;
  pointer-events: none;
}
.af-root .ty-quiz-trigger-done::after { display: none !important; }
.af-root .ty-quiz-trigger-done:hover,
.af-root .ty-quiz-trigger-done:focus {
  transform: none !important;
  filter: none !important;
}

/* Quiz modal mobile breathing room */
@media (max-width: 640px) {
  .af-root .qz-head {
    padding: 24px 20px 18px !important;
    padding-top: calc(24px + env(safe-area-inset-top)) !important;
  }
  .af-root .qz-eyebrow { margin: 0 0 8px !important; }
  .af-root .qz-title { padding-right: 48px !important; }
  .af-root .qz-prog { margin-top: 14px !important; }
  .af-root .qz-step-label { margin-top: 8px !important; }
  .af-root .qz-body { padding: 24px 20px 32px !important; }
  .af-root .qz-q { margin: 0 0 6px !important; }
  .af-root .qz-q-sub { margin: 0 0 18px !important; }
  .af-root .qz-close { top: 16px !important; right: 16px !important; }
}
`;
