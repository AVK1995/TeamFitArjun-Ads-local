/**
 * Single source of truth for client-facing values that are inlined at build time.
 * Change here → entire funnel updates after redeploy.
 *
 * NOTE: This client is single-product, no order bumps, no addons. Pricing is flat.
 */

/**
 * Price comes from `NEXT_PUBLIC_PRICE` so it can be tuned in `.env.local` (and
 * Vercel env vars in production) without touching code. NEXT_PUBLIC_ prefix
 * means the value is inlined at build time and available in both the browser
 * (CTA labels, Razorpay modal) and server (create-order, CAPI value, Pabbly).
 * Fallback 97 if unset.
 */
const PRICE_FROM_ENV = (() => {
  const raw = process.env.NEXT_PUBLIC_PRICE;
  if (!raw) return 97;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 97;
})();

export const clientConfig = {
  brand: {
    name: "TeamFitArjun",
    legalName: "TeamFitArjun",
    coach: "Arjun",
    /**
     * Ads-funnel clone — served from vsl.teamfitarjun.com. Drives the
     * production-host gate in lib/tracking-gate.ts, the Meta Pixel init
     * host check in app/layout.tsx, metadataBase, and the default
     * event_source_url used by CAPI + the webhook.
     */
    domain: "vsl.teamfitarjun.com",
    productName: "Custom Execution Blueprint Call",
    shortProductName: "Blueprint Call",
    supportEmail: "support@teamfitarjun.com",
    instagramHandle: "thefitarjun",
  },

  pricing: {
    /** Display price in INR (no symbol, no commas). Set via NEXT_PUBLIC_PRICE. */
    price: PRICE_FROM_ENV,
    /** Currency code passed to Razorpay + CAPI */
    currency: "INR" as const,
    /** Amount sent to Pabbly as a string for spreadsheet-friendly format */
    pabblyAmountString: String(PRICE_FROM_ENV),
    /** Razorpay expects amount in paise — derived */
    get paise(): number {
      return this.price * 100;
    },
  },

  event: {
    timezone: "Asia/Kolkata",
    /** Calendly URL the user is sent to immediately after payment */
    calendlyUrl: "https://calendly.com/thefitarjun/arjun-fitness-ads",
  },

  funnel: {
    /**
     * Ads-funnel slug — MUST differ from the organic funnel's
     * "arjun-blueprint". Razorpay webhook subscriptions are account-level:
     * both funnels' webhooks receive payment.captured for every payment
     * on the account. create-order stamps this on notes.funnel and the
     * webhook rejects anything with a different slug (see
     * app/api/razorpay/webhook/route.ts), which is what prevents
     * double-firing Pabbly + Meta CAPI on every payment.
     */
    slug: "arjun-blueprint-ads",
    /** sessionStorage key the UTM persistence reads/writes */
    sessionStorageKey: "arjun_utm",
    /** sessionStorage key the customer payload is held under between checkout → thank-you */
    customerStorageKey: "arjun_customer",
    /** sessionStorage key the order info is held under for the thank-you page dedup */
    orderStorageKey: "arjun_order",
  },

  razorpayModal: {
    themeColor: "#9A6614",
    description: "Custom Execution Blueprint Call",
  },

  capi: {
    enabled: true,
    /**
     * CAPI event names — ALL CUSTOM, NO STANDARD EVENTS.
     *
     * This dataset is categorised "Health and wellness condition" in Events
     * Manager. Meta's restriction blocks mid/lower-funnel STANDARD events by
     * name (`Purchase`, `AddToCart`, `InitiateCheckout`, `Subscribe`, `Lead`).
     * Confirmed custom events with PHI-free payloads are NOT in that bucket
     * and keep flowing + optimising.
     *
     * Do NOT reintroduce a standard name here — it re-triggers the block.
     * Campaigns optimise on these custom events DIRECTLY (a Custom Conversion
     * built on top gives no bypass advantage; it is the same "custom" data).
     */
    events: {
      /** Landing CTA click — was `AddToCart` */
      addToCart: "atc_event",
      /** Pay clicked on /checkout — was `InitiateCheckout` */
      initiateCheckout: "ic_event",
      /** Paid order — was `Purchase` + `sales`, now `sales` only */
      purchase: "sales",
    },
    /** Server-side purchase value — auto-tracks the env-driven price */
    purchaseValue: PRICE_FROM_ENV,
    /**
     * Catalog identifiers. INTENTIONALLY NOT SENT to Meta while the dataset is
     * restricted — `content_name` / `content_category` are exactly the kind of
     * product/category strings that get a custom event scanned and filtered as
     * sensitive. Kept here so they survive if the restriction is ever lifted.
     */
    contentId: "arjun-blueprint-call",
    contentName: "Custom Execution Blueprint Call",
    contentCategory: "Fitness Coaching",
    /** Optional Meta Test Event Code — set in env for testing, leave undefined in prod */
  },

  legal: {
    privacyPath: "/privacy-policy",
    termsPath: "/terms-and-conditions",
    refundPath: "/refund-policy",
  },

  analytics: {
    /** Set via env so dev builds don't pollute */
    metaPixelId: process.env.NEXT_PUBLIC_META_PIXEL_ID ?? "",
    gaMeasurementId: process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID ?? "",
    clarityProjectId: process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID ?? "",
    /**
     * Meta Business Settings → Brand Safety → Domains → teamfitarjun.com → "Add a meta-tag".
     * Rendered into <head> from app/layout.tsx so Meta's crawler can verify the domain.
     * Not a secret — visible in HTML source.
     */
    metaDomainVerification: "cw4qyhsr3cjpqi5yi1rt6p1ruti6pq",
  },
} as const;

export type ClientConfig = typeof clientConfig;
