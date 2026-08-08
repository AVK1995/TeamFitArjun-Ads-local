"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { clientConfig } from "@/client.config";
import { readUtmFromStorage, utmToQueryString } from "@/lib/utm";
import { trackGa4EventOnce } from "@/lib/ga4";
import { buildVimeoSrc, forceUnmute, requestFullscreen } from "@/lib/video";

/**
 * Shared handler for every landing CTA. Fires two independent events:
 *   1. GA4 `add_to_cart` — deduped inside trackGa4EventOnce by localStorage.
 *   2. Meta CAPI `atc_event` (custom — the standard `AddToCart` is blocked on
 *      this Health & Wellness-restricted dataset) — fired via sendBeacon so
 *      the request survives
 *      the CTA's navigation to /checkout. Deduped by localStorage.arjun_atc_fired.
 * Never blocks navigation; every step is best-effort.
 */
function handleLandingCtaClick() {
  trackGa4EventOnce("add_to_cart");

  try {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem("arjun_atc_fired") === "1") return;
    window.localStorage.setItem("arjun_atc_fired", "1");

    const body = JSON.stringify({ eventSourceUrl: window.location.href });
    const url = "/api/meta/add-to-cart";
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    } else {
      void fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {
        // best-effort — never block the CTA
      });
    }
  } catch {
    // localStorage or sendBeacon threw — never block the CTA
  }
}

// Same VSL (cold v3) + thumbnail as the current landing page.
// Vimeo player embed (NOT a self-hosted mp4) — plays are only recorded in Vimeo
// Analytics when the video is served by Vimeo's own player.
// Do NOT add `dnt=1` to the query string: it turns Vimeo's tracking off.
const HERO_VIDEO_URL = "https://player.vimeo.com/video/1212886806";
const HERO_THUMB_URL = "/Landing%20Thumbnail.webp";

interface Slide {
  src: string;
  alt: string;
}

const ROW_1: Slide[] = [
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    src: `/transformations/top%206%20carousel%201/${n}.jpg.jpeg`,
    alt: `Featured Transformation ${String(n).padStart(2, "0")}`,
  })),
  ...[10, 15, 16, 30, 1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 13, 14, 17, 18, 19, 20, 21, 22, 25, 27, 29].map((n) => ({
    src: `/transformations/a-${n}.png`,
    alt: `Transformation ${String(n).padStart(2, "0")}`,
  })),
];

const ROW_2: Slide[] = [
  ...[7, 8, 9, 10, 11, 12].map((n) => ({
    src: `/transformations/top%206%20carousel%202/${n}.jpg.jpeg`,
    alt: `Featured Transformation ${String(n).padStart(2, "0")}`,
  })),
  ...[38, 42, 32, 34, 35, 36, 37, 40, 43, 44, 45, 46, 47, 48].map((n) => ({
    src: `/transformations/a-${n}.png`,
    alt: `Transformation ${String(n).padStart(2, "0")}`,
  })),
];

const TESTIMONIALS = [
  {
    name: "Manish",
    meta: "34 · Pune",
    before: "/Manish%20before.png",
    after: "/Manish%20after.png",
    quote:
      "Struggling with stress, thyroid fluctuations and life disruptions, Manish followed a flexible system designed by Arjun that sustained consistency, helping him reach photoshoot-level conditioning with confidence.",
    delay: undefined,
  },
  {
    name: "Amritangshu Mahapatra",
    meta: "29 · Bhubaneswar",
    before: "/Amritangshu%20before.png",
    after: "/Amritangshu%20after.png",
    quote:
      "Despite training hard, Amritangshu lacked structure until Arjun aligned his diet, training and recovery with his lifestyle, making him leaner, stronger, and finally in complete control.",
    delay: ".08s",
  },
  {
    name: "Rohan Mehra",
    meta: "Toronto, Canada",
    before: "/Rohan%20before.png",
    after: "/Rohan%20after.png",
    quote:
      "After 10 years of ineffective workouts, Rohan followed Arjun's structured approach to nutrition, tracking and accountability, finally achieving a lean physique with visible abs that he maintains long-term.",
    delay: ".16s",
  },
];

// ── Hero: health markers the programme moves ────────────────────────────────
const HEALTH_MARKERS = [
  "Diabetes",
  "Cholesterol Levels",
  "Blood Pressure",
  "Testosterone Levels",
  "Fatty Liver",
];

// ── Qualification — "This Is For You if" ────────────────────────────────────
const FOR_YOU: { lead?: string; bold: string; tail?: string }[] = [
  {
    bold: "You’ve started getting fit more times than you can count",
    tail:
      ", only to lose momentum the moment work gets busy, travel kicks in, or life gets in the way.",
  },
  {
    bold:
      "You’re a corporate professional with long workdays, client meetings, travel, or unpredictable schedules",
    tail: " that make generic fitness plans impossible to follow consistently.",
  },
  {
    lead: "You’re frustrated that despite trying diets, gyms or online coaches, ",
    bold:
      "you’re still carrying stubborn belly fat and don’t have the lean, athletic physique you want.",
  },
  {
    lead:
      "You’re beginning to see the cost of years spent putting work before your health. The belly fat won’t budge. Energy isn’t what it used to be. ",
    bold:
      "Blood sugar, cholesterol, blood pressure, testosterone or fatty liver indicators are moving in the wrong direction.",
  },
  {
    bold: "You’re looking for a personalised coaching system that fits your schedule",
    tail:
      ", food preferences and lifestyle, so this becomes the last time you have to start over.",
  },
];

/* Icons for "What's Included" — one per item, stroked on a 24px box so they
   inherit the gold and sit inside the raised .af-incl-ic chip. */
const INCL_ICONS: Record<string, React.ReactNode> = {
  diagnosis: (
    <>
      <path d="M9 3H6.6A1.6 1.6 0 005 4.6v14.8A1.6 1.6 0 006.6 21h10.8a1.6 1.6 0 001.6-1.6V4.6A1.6 1.6 0 0017.4 3H15" />
      <rect x="9" y="1.9" width="6" height="3.2" rx="1.1" />
      <path d="M8.6 12.4h2l1.2-2.4 1.6 4.4 1.2-2h2" />
    </>
  ),
  blueprint: (
    <>
      <path d="M2.9 6.6l6.3-2.7 5.6 2.7 5.3-2.7v13.5l-5.3 2.7-5.6-2.7-6.3 2.7V6.6z" />
      <path d="M9.2 3.9v13.5M14.8 6.6v13.5" />
    </>
  ),
  nutrition: (
    <>
      <path d="M12 8.3c1.1-2.6 3.6-3.6 5.6-2.9 2.3.8 3.3 3.6 2.2 6.7-1 3-3.8 6.4-5.9 7.6-1.2.7-2.6.7-3.8 0-2.1-1.2-4.9-4.6-5.9-7.6-1.1-3.1-.1-5.9 2.2-6.7 2-.7 4.5.3 5.6 2.9z" />
      <path d="M12 8.3V5.1a2.4 2.4 0 012.4-2.4" />
    </>
  ),
  training: (
    <>
      <path d="M2.6 9.6v4.8M6.2 7.2v9.6M17.8 7.2v9.6M21.4 9.6v4.8M6.2 12h11.6" />
    </>
  ),
  support: (
    <>
      <path d="M20.6 14.4a2.2 2.2 0 01-2.2 2.2H7.2L3.4 20.4V5.6a2.2 2.2 0 012.2-2.2h12.8a2.2 2.2 0 012.2 2.2v8.8z" />
      <path d="M8.4 8.6h7.2M8.4 12h4.8" />
    </>
  ),
  progress: (
    <>
      <path d="M3.2 20.4V13M9.1 20.4V8.6M14.9 20.4v-6.6M20.8 20.4V4.4" />
      <path d="M3.2 10.2l5.9-4.4 5.8 3.3 5.9-5.5" />
    </>
  ),
};

// ── What's included in the 90-day programme ─────────────────────────────────
const INCLUDED = [
  {
    icon: "diagnosis",
    title: "Lifestyle & Constraint Diagnosis",
    desc: "Before we recommend a single meal or workout, we understand your work schedule, travel, food preferences, available equipment, injuries, recovery capacity and non-negotiables. Because a plan only works when it fits your real life.",
  },
  {
    icon: "blueprint",
    title: "Your Custom Execution Blueprint™",
    desc: "A completely personalised nutrition, training and lifestyle roadmap built around your schedule, food preferences and goals. Indian food, restaurant meals, travel days or weekend plans, everything is mapped so you never have to guess what to do next.",
  },
  {
    icon: "nutrition",
    title: "Adaptive Nutrition System",
    desc: "No rigid meal plans or fancy recipes. Your nutrition evolves with your routine, whether you’re travelling, eating out, fasting, working late or managing back-to-back meetings, so staying on track feels effortless.",
  },
  {
    icon: "training",
    title: "Context-Based Training Protocol",
    desc: "Your workouts are designed around the equipment you actually have access to, your injury history, recovery and schedule. Whether you’re training at home, in a commercial gym or a hotel gym, your plan adapts with you.",
  },
  {
    icon: "support",
    title: "Real-Time Accountability & Coach Support",
    desc: "No waiting 24-48 hours for a reply. Get direct access, fast responses, weekly reviews, form checks and personalised guidance whenever you need it, so small setbacks never become complete restarts.",
  },
  {
    icon: "progress",
    title: "Progressive Conditioning Framework",
    desc: "The goal isn’t just losing weight. Every phase is designed to reduce body fat, build visible muscle and improve conditioning while creating habits and systems that keep you progressing long after the programme ends.",
  },
];

// ── Results guarantee — what we ask in return ───────────────────────────────
const GUARANTEE_ASKS = [
  "You complete the programme. Workouts followed. Nutrition plan implemented. Weekly check-ins attended. Progress photos and measurements submitted on schedule.",
  "You actively communicate with your coach whenever work, travel or life disrupts your routine, so your plan can be adjusted accordingly.",
  "The guarantee applies when you’ve consistently followed your personalised plan and completed the full programme.",
];

const FAQS = [
  {
    q: "Is this going to be another generic program with a new label on it?",
    a: "No, and you'll be able to verify that on the call itself. The first 10 minutes are Arjun diagnosing your specific history and week structure. If what he says sounds like it could apply to anyone, invoke the refund. That's what it's there for.",
  },
  {
    q: "What if I sign up for coaching and Arjun disappears like my last coach did?",
    a: "Direct access to Arjun is the product, not a bonus. No assistant replies, no 48-hour delays. It's also why his client capacity is capped and why this page filters as hard as it does.",
  },
  {
    q: "I travel 10 to 15 days a month. Will this even work for my life?",
    a: "Travel-heavy professionals are the exact profile this methodology was built around. The Blueprint is designed from your worst weeks backwards, not your best weeks forwards. Bring your real calendar to the call.",
  },
  {
    q: `Is the ₹${clientConfig.pricing.price} call a setup for a high-pressure sales pitch?`,
    a: 'The program is offered on the call only if Arjun believes it fits, and the price is stated plainly, once. No countdown, no "only 2 spots left", no discount games. If you ever feel pressured, use the refund. His brand runs on the opposite of pressure.',
  },
  {
    q: "How fast will I see results if I join the program?",
    a: "Honest timeline: around 12 weeks for a visible shift, 8 to 12 months for full conditioning if you're starting at 95 kg or above. Anyone promising faster is selling you the cycle you've already lived through.",
  },
];

export function LandingView({ posterUrl = HERO_THUMB_URL }: { posterUrl?: string }) {
  const [openFaq, setOpenFaq] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  /** Which control started playback — only the button opens fullscreen. */
  const [wantsFullscreen, setWantsFullscreen] = useState(false);
  const videoBoxRef = useRef<HTMLDivElement>(null);
  const videoFrameRef = useRef<HTMLIFrameElement>(null);
  const [lightbox, setLightbox] = useState<{ slides: Slide[]; index: number } | null>(null);

  /**
   * Start the VSL.
   *
   * `fullscreen` is only true for the "Watch The Short Video Below" button;
   * clicking the poster plays inline in its own frame.
   *
   * When fullscreen is wanted, the request is issued SYNCHRONOUSLY here —
   * before the state update that mounts the iframe — because browsers only
   * grant it while the click gesture is still being processed. On iOS the
   * request is a no-op and buildVimeoSrc drops `playsinline` instead, letting
   * the system player take over fullscreen.
   */
  function playVideo(fullscreen = false) {
    if (videoPlaying) return;
    if (fullscreen) requestFullscreen(videoBoxRef.current);
    setWantsFullscreen(fullscreen);
    setVideoPlaying(true);
    trackGa4EventOnce("video_play");
  }

  // Vimeo silently falls back to muted playback whenever the browser blocks
  // unmuted autoplay, so tell the player to unmute once it reports ready.
  useEffect(() => {
    if (!videoPlaying) return;
    return forceUnmute(videoFrameRef.current);
  }, [videoPlaying]);
  const [timeLeft, setTimeLeft] = useState({ h: "06", m: "00", s: "00" });
  const [checkoutHref, setCheckoutHref] = useState("/checkout");

  useEffect(() => {
    if (typeof window === "undefined") return;

    const utm = readUtmFromStorage(clientConfig.funnel.sessionStorageKey);
    const qs = utmToQueryString(utm);
    setCheckoutHref(`/checkout?from=landing${qs}`);

    // 6-hour offer window. Key is versioned so sessions anchored to the old
    // 15-minute countdown don't start mid-cycle after this change ships.
    const DURATION = 6 * 60 * 60 * 1000;
    const STORAGE_KEY = "arjun_countdown_started_v2";
    let started: number;
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      started = raw ? parseInt(raw, 10) : Date.now();
      if (!raw) window.sessionStorage.setItem(STORAGE_KEY, String(started));
    } catch {
      started = Date.now();
    }
    function tick() {
      let remaining = started + DURATION - Date.now();
      if (remaining <= 0) {
        const elapsed = Date.now() - started;
        const cyclesCompleted = Math.max(1, Math.floor(elapsed / DURATION));
        started = started + cyclesCompleted * DURATION;
        try {
          window.sessionStorage.setItem(STORAGE_KEY, String(started));
        } catch {
          // sessionStorage unavailable — ignore
        }
        remaining = started + DURATION - Date.now();
      }
      const totalSec = Math.floor(remaining / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      setTimeLeft({
        h: String(h).padStart(2, "0"),
        m: String(m).padStart(2, "0"),
        s: String(s).padStart(2, "0"),
      });
    }
    tick();
    const tickId = window.setInterval(tick, 1000);

    return () => {
      window.clearInterval(tickId);
    };
  }, []);

  useEffect(() => {
    if (!lightbox) return;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
      else if (e.key === "ArrowLeft") nav(-1);
      else if (e.key === "ArrowRight") nav(1);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox]);

  function nav(delta: number) {
    setLightbox((prev) => {
      if (!prev) return prev;
      const n = prev.slides.length;
      return { ...prev, index: (prev.index + delta + n) % n };
    });
  }

  const price = clientConfig.pricing.price;

  return (
    <div
      className="af-root"
      style={{
        display: "block",
        width: "100%",
        background: "#FFFFFF",
        color: "#1C1710",
        fontFamily: "Inter, sans-serif",
      }}
    >
      {/* Announcement bar — static (no marquee), two claims only */}
      <div className="af-announce af-announce-static">
        <div className="af-announce-track">
          <span><b>5+ Years</b> Of Coaching</span>
          <span className="dot" />
          <span><b>1500+</b> Success Stories Globally</span>
        </div>
      </div>

      {/* A · Hero */}
      <section className="af-hero" style={{ background: "var(--bg)" }}>
        <div className="af-wrap af-hero-inner">
          {/* Social-proof row: avatars + rating */}
          <div className="af-proofrow" data-af-reveal>
            <div className="af-avatars" aria-hidden="true">
              {TESTIMONIALS.map((t) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={t.name} src={t.after} alt="" loading="eager" decoding="async" />
              ))}
            </div>
            <div className="af-proofrow-text">
              <span className="af-stars"><span className="sbox">★★★★★</span></span>
              <span><b>5.0</b> Review</span>
              <span className="af-proofrow-div" />
              <span className="af-proof-claim">
                <span className="af-proof-ic"><IconTrophy /></span>
                100% Guaranteed Results
              </span>
            </div>
          </div>

          <div className="af-callout" data-af-reveal>
            For Corporate Professionals 30+ Who Are Tired Of Starting Over Every Time Work Gets Busy
          </div>

          <h1 className="af-h1" data-af-reveal style={{ "--d": ".06s" } as React.CSSProperties}>
            Lose <span className="af-hl-block">10&ndash;20 Kilos</span>,<br />
            Build <span className="af-accent">Visible Muscle</span>,<br />
            &amp; Never Start Over Again
          </h1>

          <p className="af-sub af-sub-strong" data-af-reveal style={{ "--d": ".12s" } as React.CSSProperties}>
            Using the Custom Execution Blueprint, a personalised roadmap designed for demanding careers,
            frequent travel and unpredictable schedules.
          </p>

          <p className="af-sub af-sub-markers" data-af-reveal style={{ "--d": ".16s" } as React.CSSProperties}>
            <b>1500+ Corporate Professionals</b> across{" "}
            <span className="af-hl">India, UK, Canada, Australia &amp; UAE</span> have{" "}
            <span className="af-hl-pill">lost 10+ kilos</span>, built visible muscle and improved key
            health markers linked to:
          </p>

          <ul className="af-markers" data-af-reveal style={{ "--d": ".2s" } as React.CSSProperties}>
            {HEALTH_MARKERS.map((m, i) => (
              <li key={m} style={{ "--pd": `${i * 0.22}s` } as React.CSSProperties}>
                <span className="af-marker-dot" aria-hidden="true" />
                {m}
              </li>
            ))}
          </ul>

          <div className="af-watch" data-af-reveal style={{ "--d": ".24s" } as React.CSSProperties}>
            <button type="button" className="af-watch-box" onClick={() => playVideo(true)}>
              Watch The Short Video Below
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M19 12l-7 7-7-7" /></svg>
            </button>
          </div>

          <div className="af-video-frame" data-af-reveal style={{ "--d": ".26s" } as React.CSSProperties}>
            <div
              ref={videoBoxRef}
              className={`af-video ${videoPlaying ? "playing" : ""}`}
              id="af-vsl"
              role="button"
              aria-label="Play video"
              onClick={() => playVideo(false)}
            >
              <div
                className={`af-video-thumb ${videoPlaying ? "" : "on"}`}
                id="af-vthumb"
                style={{
                  backgroundImage: `url("${posterUrl}")`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  backgroundRepeat: "no-repeat",
                }}
              />
              {!videoPlaying ? (
                <div className="af-play">
                  <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                </div>
              ) : (
                <iframe
                  ref={videoFrameRef}
                  src={buildVimeoSrc(HERO_VIDEO_URL, { fullscreen: wantsFullscreen })}
                  title="Custom Execution Blueprint Call — Arjun Shah"
                  allow="autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media"
                  allowFullScreen
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    border: 0,
                    zIndex: 5,
                    background: "#000",
                  }}
                />
              )}
            </div>
          </div>

          <CtaBlock checkoutHref={checkoutHref} time={timeLeft} delay=".3s" extraStyle={{ marginTop: 8 }} />
        </div>
      </section>

      {/* Credibility strip */}
      <section className="af-creds" style={{ background: "var(--bg-alt)" }}>
        <div className="af-wrap">
          <div className="af-creds-grid" data-af-reveal>
            {[
              { num: "1500+", label: "Success Stories", sub: "Globally" },
              { num: "Featured On", label: "Aaj Tak · Zee News", sub: "HealthXP Featured", wide: true },
              { num: "5.0 ★", label: "Client Rating", sub: "Verified Reviews" },
              { num: `₹${price}`, label: "To Start", sub: "Fully Refundable" },
            ].map((c) => (
              <div className="af-cred-item" key={c.label}>
                <div className="af-cred-num">{c.num}</div>
                <div className={`af-cred-label${c.wide ? " af-cred-text" : ""}`}>{c.label}</div>
                <div className="af-cred-sub">{c.sub}</div>
              </div>
            ))}
          </div>

        </div>
      </section>

      {/* B · Qualification — This Is For You If */}
      <section className="af-two af-foryou" style={{ background: "var(--bg)" }}>
        <div className="af-wrap">
          <p className="af-eyebrow" data-af-reveal>
            For Corporate Professionals Across India &amp; Abroad
          </p>
          <h2 data-af-reveal style={{ "--d": ".04s" } as React.CSSProperties}>
            This Is For You <span className="af-accent af-underline">If</span>
          </h2>
          <ul className="af-foryou-list" data-af-reveal style={{ "--d": ".08s" } as React.CSSProperties}>
            {FOR_YOU.map((item, i) => (
              <li key={i}>
                <span className="af-foryou-tick" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
                </span>
                <p>
                  {item.lead}
                  <strong>{item.bold}</strong>
                  {item.tail}
                </p>
              </li>
            ))}
          </ul>
          <CtaBlock
            checkoutHref={checkoutHref}
            time={timeLeft}
            wrapperClass="af-cta-block af-two-cta"
            extraStyle={{ marginTop: 40 }}
          />
        </div>
      </section>

      {/* C · Proof — testimonials */}
      <section className="af-proof" style={{ background: "var(--bg-alt)" }}>
        <div className="af-wrap">
          <p className="af-eyebrow" data-af-reveal>Real Professionals. Real Schedules. Real Results.</p>
          <h2 data-af-reveal style={{ "--d": ".04s" } as React.CSSProperties}>
            Corporate Professionals Who Proved <em>&ldquo;Busy&rdquo;</em>
            <br className="af-br-desk" /> Doesn&rsquo;t Have To Mean <em>&ldquo;Unfit&rdquo;</em>
          </h2>
          <p className="af-section-lede" data-af-reveal style={{ "--d": ".06s" } as React.CSSProperties}>
            From IT professionals and bankers to founders and senior executives, these are men who
            transformed with the Custom Execution Blueprint.
          </p>
          <div className="af-tcards">
            {TESTIMONIALS.map((t) => (
              <article
                key={t.name}
                className="af-tcard"
                data-af-reveal
                style={t.delay ? ({ "--d": t.delay } as React.CSSProperties) : undefined}
              >
                <div className="af-tphoto">
                  <div className="tside b">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={t.before} alt={`${t.name.split(" ")[0]} before`} loading="lazy" decoding="async" />
                    <div><BeforeAfterSvg /><br />Before</div>
                  </div>
                  <div className="tside a">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={t.after} alt={`${t.name.split(" ")[0]} after`} loading="lazy" decoding="async" />
                    <div><BeforeAfterSvg /><br />After</div>
                  </div>
                  <div className="vline" />
                  <span className="tag tb">Before</span>
                  <span className="tag ta">After</span>
                </div>
                <div className="af-tcard-body">
                  <h4>{t.name}</h4>
                  <div className="meta">{t.meta}</div>
                  <div className="stars">★★★★★</div>
                  <p>{t.quote}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Carousel gallery */}
      <section className="af-gallery" style={{ background: "var(--bg)", overflow: "hidden" }}>
        <div className="af-wrap">
          <p className="af-eyebrow" data-af-reveal>
            Real Men. Real Timelines. No Filters.
          </p>
          <h2 data-af-reveal style={{ marginBottom: 36 }}>
            Before &amp; After <span>Transformations</span>
          </h2>
        </div>
        <CarouselRow
          id="af-gal-carousel-1"
          trackId="af-gal-track-1"
          setId="af-gal-set-1"
          direction="ltr"
          slides={ROW_1}
          onSlideClick={(i) => setLightbox({ slides: ROW_1, index: i })}
        />
        <CarouselRow
          id="af-gal-carousel-2"
          trackId="af-gal-track-2"
          setId="af-gal-set-2"
          direction="rtl"
          extraClass="af-gal-carousel-row2"
          slides={ROW_2}
          onSlideClick={(i) => setLightbox({ slides: ROW_2, index: i })}
        />
        <div className="af-wrap" />
      </section>

      {/* D · About Arjun */}
      <section className="af-about" style={{ background: "var(--bg-alt)" }}>
        <div className="af-wrap">
          <div className="af-about-grid">
            <div className="af-about-photo" data-af-reveal style={{ position: "relative" }}>
              <span className="badge">Meet Your Coach</span>
              <div className="frame" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/Meet%20Your%20Coach%20Arjun.png"
                alt="Arjun Shah"
                loading="lazy"
                decoding="async"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
              />
              <div className="count">
                <div><b>104kg → 65kg</b><span>His Own Journey</span></div>
                <div><b>1,500+</b><span>Clients</span></div>
              </div>
            </div>
            <div className="af-about-text" data-af-reveal style={{ "--d": ".12s" } as React.CSSProperties}>
              <p className="af-eyebrow af-eyebrow-left">Meet Your Coach</p>
              <h2>
                The Coach Who&rsquo;s<br className="af-br-mob" />{" "}
                <span>Lived Both Sides</span>
              </h2>
              <p>
                Arjun Shah spent years at <span className="af-hl-pill">104 kg</span> before engineering
                himself down to <span className="af-hl-pill">65kg</span>. Not with motivation, with{" "}
                <span className="af-hl">a system that survived his own bad weeks</span>.
              </p>
              <p>
                Over the last <span className="af-hl">5 years</span> he&rsquo;s coached more than{" "}
                <span className="af-hl-pill">1,500 clients</span> across{" "}
                <span className="af-hl">India, the US, UK, Canada, Australia and the UAE</span>, the bulk
                of them men like you: corporate professionals with real careers, real families, and{" "}
                <strong>no time for a plan that only works in theory</strong>.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* E · What's included in the 90-day programme */}
      <section className="af-incl" style={{ background: "var(--bg)" }}>
        <div className="af-wrap">
          <h2 data-af-reveal style={{ textAlign: "center" } as React.CSSProperties}>
            What&rsquo;s Included In Your<br className="af-br-mob" />{" "}
            <span className="af-accent">90-Day Programme</span>
          </h2>
          <p className="af-section-lede" data-af-reveal style={{ "--d": ".05s" } as React.CSSProperties}>
            Everything working together to make this the{" "}
            <span className="af-underline-ink">last fitness programme</span> you ever need.
          </p>
          <div className="af-incl-grid" data-af-reveal style={{ "--d": ".08s" } as React.CSSProperties}>
            {INCLUDED.map((item) => (
              <article className="af-incl-card" key={item.title}>
                <span className="af-incl-ic" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    {INCL_ICONS[item.icon]}
                  </svg>
                </span>
                <h4>{item.title}</h4>
                <p>{item.desc}</p>
              </article>
            ))}
          </div>
          <CtaBlock
            checkoutHref={checkoutHref}
            time={timeLeft}
            extraStyle={{ marginTop: 44 }}
          />
        </div>
      </section>

      {/* F · Results guarantee */}
      <section className="af-money af-guar" style={{ background: "var(--bg-alt)" }}>
        <div className="af-wrap">
          <div className="af-guar-badge" data-af-reveal>
            <span className="af-guar-ring" aria-hidden="true" />
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2.4l7.6 2.9v6.4c0 4.7-3.2 8.8-7.6 9.6-4.4-.8-7.6-4.9-7.6-9.6V5.3L12 2.4z" />
              <path d="M8.7 12.2l2.3 2.3 4.3-4.5" className="tick" />
            </svg>
          </div>
          <p className="af-eyebrow" data-af-reveal style={{ "--d": ".02s" } as React.CSSProperties}>
            The Risk Is Ours. Not Yours.
          </p>
          <h2 data-af-reveal style={{ textAlign: "center", "--d": ".04s" } as React.CSSProperties}>
            100% <span className="af-accent">Results Guarantee</span>
          </h2>
          <p className="af-section-lede" data-af-reveal style={{ "--d": ".06s" } as React.CSSProperties}>
            If you don&rsquo;t see visible progress by the end of your programme, despite following your
            personalised Custom Execution Blueprint, we&rsquo;ll continue coaching you at no additional
            cost until you do.
          </p>
          <div className="af-guar-card" data-af-reveal style={{ "--d": ".1s" } as React.CSSProperties}>
            <h4>What We Ask In Return</h4>
            <ul>
              {GUARANTEE_ASKS.map((a) => (
                <li key={a}>
                  <span className="af-guar-tick" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
                  </span>
                  {a}
                </li>
              ))}
            </ul>
            <p className="af-guar-note">
              The ₹{price} pre-strategy fee is also fully refundable if we are not the right fit.
            </p>
          </div>
        </div>
      </section>

      {/* G · FAQ */}
      <section className="af-faq" style={{ background: "var(--bg)" }}>
        <div className="af-wrap">
          <p className="af-eyebrow" data-af-reveal>
            Straight Answers. No Sales Spin.
          </p>
          <h2 data-af-reveal style={{ "--d": ".04s" } as React.CSSProperties}>
            Common Questions from <span>Corporate Professionals</span>
          </h2>
          <div className="af-faq-list">
            {FAQS.map((f, i) => {
              const isOpen = openFaq === i;
              return (
                <div key={f.q} className={`af-q ${isOpen ? "open" : ""}`}>
                  <div
                    className="af-q-head"
                    onClick={() => setOpenFaq(isOpen ? -1 : i)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenFaq(isOpen ? -1 : i);
                      }
                    }}
                  >
                    <span>{f.q}</span>
                    <span className="ic">
                      <svg viewBox="0 0 24 24">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    </span>
                  </div>
                  <div className="af-q-body">
                    <div className="af-q-body-inner">{f.a}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Closing CTA — lives inside the FAQ section so it shares the same
              background and reads as one continuous band. */}
          <div className="af-faq-cta" id="book">
            <CtaBlock checkoutHref={checkoutHref} time={timeLeft} delay=".1s" />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="af-foot">
        <div className="af-wrap">
          <div className="copy">© 2026 Arjun Fitness. All rights reserved.</div>
          <p>
            All content, systems and coaching services provided by Arjun Fitness Coaching are intended for
            educational and informational purposes only and do not guarantee specific results. This is not
            medical, legal or licensed professional advice. Always consult a qualified healthcare professional
            before making changes to your diet, exercise or lifestyle. Client results and testimonials vary
            based on individual factors such as consistency, medical history, lifestyle and adherence to the
            process. Outcomes are not typical or guaranteed. This website is not affiliated with or endorsed by
            Meta. FACEBOOK and INSTAGRAM are trademarks of Meta Platforms, Inc.
          </p>
          <p style={{ marginTop: 10 }}>Owned and operated by Arjun Shah.</p>
          <div className="links">
            <Link href="/privacy-policy">Privacy Policy</Link> ·{" "}
            <Link href="/terms-and-conditions">Terms &amp; Conditions</Link> ·{" "}
            <Link href="/refund-policy">Refund Policy</Link>
          </div>
        </div>
      </footer>

      {/* Sticky CTA */}
      <div className="af-stuck on" id="af-stuck">
        {/* Animated gold sweep along the top edge */}
        <span className="af-stuck-beam" aria-hidden="true" />
        <div className="af-stuck-inner">
          <Link href={checkoutHref} className="af-cta" onClick={handleLandingCtaClick}>
            <span className="cta-top">
              <CtaLabel />
              <span className="arrow">
                <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 5l7 7-7 7" />
                </svg>
              </span>
            </span>
          </Link>
          <ul className="af-stuck-trust">
            <li>
              <span className="af-trust-ic"><IconGuarantee /></span>
              100% Results Guarantee
            </li>
            <li>
              <span className="af-trust-ic"><IconMedal /></span>
              1500+ Success Stories Globally
            </li>
          </ul>
        </div>
      </div>

      {/* Lightbox */}
      {lightbox ? (
        <div className="af-lbox on" id="af-lbox" role="dialog" aria-hidden="false">
          <div className="af-lbox-content">
            <button className="af-lbox-close" type="button" aria-label="Close" onClick={() => setLightbox(null)}>
              <svg viewBox="0 0 24 24">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <button className="af-lbox-nav af-lbox-prev" type="button" aria-label="Previous" onClick={() => nav(-1)}>
              <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="af-lbox-img" src={lightbox.slides[lightbox.index].src} alt={lightbox.slides[lightbox.index].alt} />
            <button className="af-lbox-nav af-lbox-next" type="button" aria-label="Next" onClick={() => nav(1)}>
              <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
            <div className="af-lbox-counter">
              {lightbox.index + 1} / {lightbox.slides.length}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ─── helpers ─── */

function CtaBlock({
  checkoutHref,
  time,
  wrapperClass,
  extraStyle,
  delay,
}: {
  checkoutHref: string;
  time: TimeLeft;
  wrapperClass?: string;
  extraStyle?: React.CSSProperties;
  delay?: string;
}) {
  const price = clientConfig.pricing.price;

  const style: React.CSSProperties = {
    ...(delay ? ({ "--d": delay } as React.CSSProperties) : {}),
    ...(extraStyle ?? {}),
  };

  return (
    <div className={wrapperClass ?? "af-cta-block"} data-af-reveal style={style}>
      <Link href={checkoutHref} className="af-cta" onClick={handleLandingCtaClick}>
        <span className="cta-top">
          <CtaLabel />
          <span className="arrow">
            <svg viewBox="0 0 24 24">
              <path d="M5 12h14M13 5l7 7-7 7" />
            </svg>
          </span>
        </span>
      </Link>

      {/* Trust row under the button */}
      <ul className="af-trustrow">
        <li>
          <span className="af-trust-ic"><IconGuarantee /></span>
          100% Results Guarantee
        </li>
        <li>
          <span className="af-trust-ic"><IconMedal /></span>
          1500+ Success Stories
        </li>
        <li>
          <span className="af-trust-ic"><IconGlobe /></span>
          Trusted by Corporate Professionals Globally
        </li>
      </ul>

      <Countdown time={time} />
    </div>
  );
}

/**
 * Shared CTA label. One line on desktop; the <br> is enabled below 640px so
 * the label breaks after "Diagnosis" instead of wrapping wherever it lands.
 */
function CtaLabel() {
  return (
    <span className="cta-lbl">
      Click Here To Get Your Personalized Diagnosis{" "}
      <br className="cta-br" />&amp; Custom Execution Blueprint
    </span>
  );
}

interface TimeLeft {
  h: string;
  m: string;
  s: string;
}

/** Segmented countdown — label outside, digits in a raised red capsule. */
function Countdown({ time, compact }: { time: TimeLeft; compact?: boolean }) {
  const units: [string, string][] = [
    [time.h, "Hrs"],
    [time.m, "Min"],
    [time.s, "Sec"],
  ];
  return (
    <div className={`af-timer${compact ? " af-timer-compact" : ""}`}>
      <span className="af-timer-label">
        <span className="af-timer-dot" />
        Offer ends in
      </span>
      <span className="af-timer-blocks">
        {units.map(([value, unit], i) => (
          <span key={unit} style={{ display: "contents" }}>
            {i > 0 ? <span className="af-tsep">:</span> : null}
            <span className="af-tblock">
              <b>{value}</b>
              <i>{unit}</i>
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}

/* Trust-row glyphs — drawn on a 24px box, stroked so they inherit the gold
   and sit inside the raised .af-trust-ic chip. */
function IconGuarantee() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.5l7.5 2.8v6.4c0 4.6-3.1 8.6-7.5 9.3-4.4-.7-7.5-4.7-7.5-9.3V5.3L12 2.5z" />
      <path d="M8.8 12.1l2.2 2.2 4.2-4.4" />
    </svg>
  );
}

function IconMedal() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="14.5" r="6" />
      <path d="M12 11.8l.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2L9 14l2-.3.9-1.9z" />
      <path d="M8.4 8.2L6.2 2.8h11.6l-2.2 5.4" />
    </svg>
  );
}

/** Trophy — replaces the 🏆 emoji so the mark is themed, not platform-drawn. */
function IconTrophy() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.4 3.4h9.2v5.1a4.6 4.6 0 01-9.2 0V3.4z" />
      <path d="M7.4 5.1H4.9a2 2 0 000 4h.9M16.6 5.1h2.5a2 2 0 010 4h-.9" />
      <path d="M12 13.1v3.3M8.9 20.6h6.2l-.7-4.2H9.6l-.7 4.2z" />
    </svg>
  );
}

function IconGlobe() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9.2" />
      <path d="M2.8 12h18.4" />
      <path d="M12 2.8c2.5 2.7 3.8 5.8 3.8 9.2S14.5 18.5 12 21.2c-2.5-2.7-3.8-5.8-3.8-9.2S9.5 5.5 12 2.8z" />
    </svg>
  );
}


function BeforeAfterSvg() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

interface CarouselRowProps {
  id: string;
  trackId: string;
  setId: string;
  direction: "ltr" | "rtl";
  slides: Slide[];
  extraClass?: string;
  onSlideClick: (idx: number) => void;
}

function CarouselRow({
  id,
  trackId,
  setId,
  direction,
  slides,
  extraClass,
  onSlideClick,
}: CarouselRowProps) {
  const carouselRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const setRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const carousel = carouselRef.current;
    const track = trackRef.current;
    const set = setRef.current;
    if (!carousel || !track || !set) return;

    if (!document.getElementById("af-gal-keyframes")) {
      const style = document.createElement("style");
      style.id = "af-gal-keyframes";
      style.textContent = `
        @keyframes af-gal-scroll-ltr {
          from { transform: translate3d(0, 0, 0); }
          to   { transform: translate3d(-50%, 0, 0); }
        }
        @keyframes af-gal-scroll-rtl {
          from { transform: translate3d(-50%, 0, 0); }
          to   { transform: translate3d(0, 0, 0); }
        }
        .af-root .af-gal-carousel:hover .af-gal-track { animation-play-state: paused; }
        @media (prefers-reduced-motion: reduce) {
          .af-root .af-gal-track { animation: none !important; }
        }
      `;
      document.head.appendChild(style);
    }

    if (track.dataset.afPrimed !== "1") {
      track.dataset.afPrimed = "1";
      const clone = set.cloneNode(true) as HTMLElement;
      clone.removeAttribute("id");
      clone.setAttribute("aria-hidden", "true");
      track.appendChild(clone);
      const durationSec = Math.max(40, Math.round(slides.length * 3.5));
      track.style.willChange = "transform";
      track.style.animation = `${direction === "rtl" ? "af-gal-scroll-rtl" : "af-gal-scroll-ltr"} ${durationSec}s linear infinite`;
    }

    let io: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            track.style.animationPlayState = e.isIntersecting ? "running" : "paused";
          }
        },
        { threshold: 0 },
      );
      io.observe(carousel);
    }
    return () => {
      if (io) io.disconnect();
    };
  }, [direction, slides.length]);

  const handleWrapperClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const slide = target.closest<HTMLElement>(".af-gslide");
    if (!slide) return;
    const idx = Number(slide.dataset.index);
    if (Number.isFinite(idx)) onSlideClick(idx);
  };

  return (
    <div
      ref={carouselRef}
      className={`af-gal-carousel ${extraClass ?? ""}`.trim()}
      id={id}
      data-direction={direction}
      onClick={handleWrapperClick}
    >
      <div ref={trackRef} className="af-gal-track" id={trackId}>
        <div ref={setRef} className="af-gal-set" id={setId}>
          {slides.map((s, i) => (
            <div
              key={s.src}
              className="af-gslide"
              data-index={i}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSlideClick(i);
                }
              }}
              style={{ cursor: "pointer" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.src} alt={s.alt} loading="lazy" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
