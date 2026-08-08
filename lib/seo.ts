/**
 * SEO metadata for every funnel route.
 *
 * Originally mirrored the WordPress build (2026-05-20). Rewritten for the
 * landing revamp: the old copy sold "Indian working men / roti + rice /
 * 40-50% belly fat / 1500+ clients", none of which the page claims any more.
 * Current positioning is corporate professionals 30+, lose 10-20 kilos and
 * build visible muscle via the Custom Execution Blueprint, 1500+ clients.
 *
 * Keep this in step with app/LandingView.tsx — a share preview that
 * contradicts the page costs trust at the worst possible moment.
 */

interface PageSeo {
  title: string;
  description: string;
  ogTitle: string;
  ogDescription: string;
  ogImage?: string;
  ogType?: "website" | "article";
  noindex?: boolean;
}

const SHARED_DESCRIPTION =
  "Personalised coaching for corporate professionals. Lose belly fat, build visible muscle, and never start over, with a plan built around your real schedule.";

export const seoMetadata: Record<string, PageSeo> = {
  home: {
    // Search result: leads with the promise, keeps the brand suffix (~55 chars).
    title: "Lose 10-20 Kilos, Build Visible Muscle | Arjun Fitness",
    description:
      "Corporate professionals 30+: lose 10-20 kilos and build visible muscle in 90 days with a Custom Execution Blueprint built around your schedule. ₹97 to start.",
    // Share preview: mirrors the H1 verbatim so the card matches the page.
    ogTitle: "Lose 10-20 Kilos, Build Visible Muscle, & Never Start Over Again",
    ogDescription:
      "A Custom Execution Blueprint for demanding careers, frequent travel and unpredictable schedules. 1500+ corporate professionals transformed. ₹97, fully refundable.",
    ogImage: "/OG Images/Home OG.png",
    ogType: "website",
  },
  checkout: {
    title: "Book Your Custom Execution Blueprint Call — ₹97 | Arjun Fitness",
    description:
      "Secure checkout for your 30-min 1:1 diagnostic call with Arjun Shah. ₹97. 100% money-back guarantee. UPI, Cards & NetBanking accepted.",
    ogTitle: "Book Your Custom Execution Blueprint Call — ₹97 | Arjun Fitness",
    ogDescription:
      "Secure checkout for your 30-min 1:1 diagnostic call with Arjun Shah. ₹97. 100% money-back guarantee. UPI, Cards & NetBanking accepted.",
    ogImage: "/OG Images/Checkout OG.png",
    ogType: "website",
    noindex: true,
  },
  bookACall: {
    title: "Pick Your Call Slot — Custom Execution Blueprint | Arjun Fitness",
    description:
      "Choose a 30-minute time slot that works for you. Confirm your booking and get the Zoom link via email. Limited slots open weekly.",
    ogTitle: "Pick Your Call Slot — Custom Execution Blueprint | Arjun Fitness",
    ogDescription:
      "Choose a 30-minute time slot that works for you. Confirm your booking and get the Zoom link via email. Limited slots open weekly.",
    ogImage: "/OG Images/Book A Call OG.png",
    ogType: "website",
    noindex: true,
  },
  thankYou: {
    title: "Booking Confirmed | Complete Your Diagnostic — Arjun Fitness",
    description: SHARED_DESCRIPTION,
    ogTitle: "Thank You | Arjun Fitness",
    ogDescription: SHARED_DESCRIPTION,
    ogImage: "/OG Images/Thank You OG.png",
    ogType: "website",
    noindex: true,
  },
  paymentFailed: {
    title: "Payment Could Not Be Processed — Arjun Fitness",
    description: SHARED_DESCRIPTION,
    ogTitle: "Payment Failed | Arjun Fitness",
    ogDescription: SHARED_DESCRIPTION,
    ogType: "website",
    noindex: true,
  },
  privacy: {
    title: "Privacy Policy | Arjun Fitness",
    description: SHARED_DESCRIPTION,
    ogTitle: "Privacy Policy | Arjun Fitness",
    ogDescription: SHARED_DESCRIPTION,
    ogType: "website",
  },
  terms: {
    title: "Terms & Conditions | Arjun Fitness",
    description: SHARED_DESCRIPTION,
    ogTitle: "Terms And Conditions | Arjun Fitness",
    ogDescription: SHARED_DESCRIPTION,
    ogType: "website",
  },
  refund: {
    title: "Refund Policy & 100% Money-Back Guarantee | Arjun Fitness",
    description: SHARED_DESCRIPTION,
    ogTitle: "Refund Policy | Arjun Fitness",
    ogDescription: SHARED_DESCRIPTION,
    ogType: "website",
  },
};

export type PageKey =
  | "home"
  | "checkout"
  | "bookACall"
  | "thankYou"
  | "paymentFailed"
  | "privacy"
  | "terms"
  | "refund";

import type { Metadata } from "next";
import { clientConfig } from "@/client.config";

export function buildMetadata(key: PageKey): Metadata {
  const seo = seoMetadata[key];
  return {
    title: seo.title,
    description: seo.description,
    openGraph: {
      title: seo.ogTitle,
      description: seo.ogDescription,
      type: seo.ogType ?? "website",
      // Next merges metadata shallowly, so a page-level `openGraph` replaces
      // the layout's wholesale. Without these two lines every route silently
      // loses the siteName and locale set in app/layout.tsx.
      siteName: clientConfig.brand.name,
      locale: "en_IN",
      ...(seo.ogImage ? { images: [seo.ogImage] } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: seo.ogTitle,
      description: seo.ogDescription,
      ...(seo.ogImage ? { images: [seo.ogImage] } : {}),
    },
    robots: seo.noindex
      ? { index: false, follow: false }
      : { index: true, follow: true },
  };
}
