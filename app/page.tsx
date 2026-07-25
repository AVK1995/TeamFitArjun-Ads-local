import { UtmCapture } from "@/components/UtmCapture";
import { buildMetadata } from "@/lib/seo";
import { getVimeoPoster } from "@/lib/vimeo";
import { LandingView } from "./LandingView";
import "./landing.css";
import "./landing-premium.css";

export const dynamic = "force-static";
export const metadata = buildMetadata("home");

/** Vimeo id for the hero VSL — keep in step with HERO_VIDEO_URL in LandingView. */
const HERO_VIDEO_ID = "1212886806";
/** Used only if Vimeo is unreachable at build time. */
const POSTER_FALLBACK = "/Landing%20Thumbnail.webp";

export default async function LandingPage() {
  // Resolved at build time and inlined into the static HTML.
  const posterUrl = await getVimeoPoster(HERO_VIDEO_ID, POSTER_FALLBACK);

  return (
    <>
      {/* Preload the hero video poster (the LCP element). It's painted via a
          CSS background-image, which browsers discover late; preloading it at
          high priority lets it download immediately and improves LCP on mobile. */}
      <link
        rel="preload"
        as="image"
        href={posterUrl}
        fetchPriority="high"
      />
      <UtmCapture />
      <LandingView posterUrl={posterUrl} />
    </>
  );
}
