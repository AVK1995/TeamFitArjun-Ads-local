import type { Metadata, Viewport } from "next";
import { Playfair_Display, Inter } from "next/font/google";
import Script from "next/script";
import { clientConfig } from "@/client.config";
import { PixelPageView } from "@/components/PixelPageView";
import "./globals.css";

// Fonts are self-hosted by next/font (same-origin, preloaded, non-render-blocking).
// Weights cover every weight actually used in the CSS so we can drop the old
// render-blocking Google Fonts @import in landing.css with no visual change.
const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--fh",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--fb",
});

export const metadata: Metadata = {
  title: `${clientConfig.brand.productName} — ₹${clientConfig.pricing.price} | ${clientConfig.brand.name}`,
  description:
    "A 30-minute Custom Execution Blueprint Call with Arjun — diagnose what's actually breaking and walk away with a system that survives your real schedule.",
  metadataBase: new URL(`https://${clientConfig.brand.domain}`),
  openGraph: {
    title: `Book Your ${clientConfig.brand.shortProductName}`,
    description:
      "Real Professionals. Real Schedules. Real Results. A no-fluff 30-min call to fix what your past plans never could.",
    siteName: clientConfig.brand.name,
    type: "website",
    locale: "en_IN",
  },
  twitter: { card: "summary_large_image" },
  robots: {
    index: true,
    follow: true,
  },
  // Renders <meta name="facebook-domain-verification" content="..." />
  // Required by Meta Business → Brand Safety → Domains to verify ownership of
  // teamfitarjun.com. Once verified, event_source_url is fully trusted by
  // Meta and AEM works correctly for iOS visitors.
  other: {
    "facebook-domain-verification": clientConfig.analytics.metaDomainVerification,
  },
};

export const viewport: Viewport = {
  themeColor: "#FFFFFF",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pixelId = clientConfig.analytics.metaPixelId;
  const gaId = clientConfig.analytics.gaMeasurementId;
  const clarityId = clientConfig.analytics.clarityProjectId;
  const prodDomain = clientConfig.brand.domain;

  return (
    <html
      lang="en"
      className={`${playfair.variable} ${inter.variable}`}
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        {children}

        {/* Fires fbq('track', 'PageView') on every SPA route change after the
            initial mount. Initial PageView is fired by the inline script below. */}
        {pixelId ? <PixelPageView /> : null}

        {/* Razorpay checkout.js — lazy loaded so it doesn't block FCP */}
        <Script
          src="https://checkout.razorpay.com/v1/checkout.js"
          strategy="lazyOnload"
        />

        {/*
          Meta Pixel — fires PageView on every page load. The inline script
          guards itself with a hostname check: it only runs when served from
          the production domain (clientConfig.brand.domain). Vercel preview
          deploys (*.vercel.app) and localhost skip the entire block, so test
          traffic never lands in Events Manager.

          On production it reads the `arjun_mam` cookie (written by
          /checkout's form-fill useEffect, persisted 30 days) and re-inits
          the pixel with that hashed identity BEFORE PageView fires — so
          even cold returns ship PageView with em/ph/fn/ln/ct/country/external_id.

          This is the ONLY browser event the funnel fires. Every conversion
          event comes from server CAPI and every one is a CUSTOM event name
          (atc_event / ic_event / sales) because this dataset is under Meta's
          Health & Wellness restriction — see clientConfig.capi.events.
        */}
        {pixelId ? (
          <>
            <Script id="meta-pixel-init" strategy="afterInteractive">
              {`(function(){var h=(window.location.hostname||'').toLowerCase();var d='${prodDomain}';if(h!==d&&!h.endsWith('.'+d))return;!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${pixelId}');try{var m=document.cookie.match(/(?:^|;\\s*)arjun_mam=([^;]+)/);if(m){var mam=JSON.parse(decodeURIComponent(m[1]));if(mam&&typeof mam==='object'&&Object.keys(mam).length){fbq('init','${pixelId}',mam);}}}catch(e){}var pv=window.__arjun_last_pv;var pn=window.location.pathname;var nw=Date.now();if(!(pv&&pv.pathname===pn&&nw-pv.at<1000)){window.__arjun_last_pv={pathname:pn,at:nw};fbq('track','PageView');}})();`}
            </Script>
            <noscript>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                height="1"
                width="1"
                style={{ display: "none" }}
                alt=""
                src={`https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1`}
              />
            </noscript>
          </>
        ) : null}

        {/* GA4 */}
        {gaId ? (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
              strategy="afterInteractive"
            />
            <Script id="ga-init" strategy="afterInteractive">
              {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${gaId}',{send_page_view:true});`}
            </Script>
          </>
        ) : null}

        {/* Microsoft Clarity — session recordings + heatmaps. Self-injects its
            own <script> tag, so a single inline init is all that's needed. */}
        {clarityId ? (
          <Script id="clarity-init" strategy="afterInteractive">
            {`(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${clarityId}");`}
          </Script>
        ) : null}
      </body>
    </html>
  );
}
