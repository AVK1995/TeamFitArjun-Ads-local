"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { clientConfig } from "@/client.config";
import { reapplyMamFromCookie } from "@/lib/analytics";
import { buildVimeoSrc, forceUnmute } from "@/lib/video";
import { QUIZ_QUESTIONS } from "./quizQuestions";

// Vimeo player embed (NOT a self-hosted mp4) — plays are only recorded in Vimeo
// Analytics when the video is served by Vimeo's own player.
// Do NOT add `dnt=1` to the query string: it turns Vimeo's tracking off.
const HERO_VIDEO_URL = "https://player.vimeo.com/video/1212886807";
const HERO_THUMB_URL = "/Thank%20you%20page%20video%20thumbnail.png";
const INSTAGRAM_URL = "https://www.instagram.com/thefitarjun/";

type AnswerMap = Record<string, string | string[]>;

/**
 * sessionStorage key for the "already submitted" lock. Cleared on a new
 * browser session, so the same user can submit again from a fresh window /
 * incognito if they need to — but never accidentally double-submit during
 * the same session.
 */
const QUIZ_SUBMITTED_KEY = "arjun_quiz_submitted";

export function ThankYouView({ posterUrl = HERO_THUMB_URL }: { posterUrl?: string }) {
  const [quizOpen, setQuizOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [shake, setShake] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const [stickyOn, setStickyOn] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  /** Persists across refreshes within the current browser session */
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);

  const total = QUIZ_QUESTIONS.length;
  const step = QUIZ_QUESTIONS[currentStep];

  // Sticky scroll + read submission-lock on mount.
  // No browser Pixel events fire on /thank-you. The custom `sales` event is
  // fired server-side from /api/razorpay/webhook with a payload
  // that hits EMQ ≥ 9.5. We do re-apply the arjun_mam cookie identity here
  // as a safety net so the PageView (fired from layout) carries hashed
  // matching even if the inline script raced the route change.
  useEffect(() => {
    if (typeof window === "undefined") return;

    reapplyMamFromCookie();

    // Rehydrate "already submitted" flag from sessionStorage. If true, both
    // CTAs render as a static "Form Submitted" button and clicking does
    // nothing — survives page refresh, gone on new browser session.
    try {
      if (window.sessionStorage.getItem(QUIZ_SUBMITTED_KEY) === "1") {
        setAlreadySubmitted(true);
      }
    } catch {
      // private mode / quota — fail safely
    }

    const sticky = () => {
      const mainCta = document.querySelector<HTMLElement>(".ty-form-cta");
      if (!mainCta) return;
      const onScroll = () =>
        setStickyOn(mainCta.getBoundingClientRect().bottom < 0);
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
      return onScroll;
    };
    const onScroll = sticky();

    // Reveal animations are CSS-only (auto-playing keyframe) — no JS observer.

    return () => {
      if (onScroll) window.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Body scroll lock + ESC close while modal open
  useEffect(() => {
    if (!quizOpen) return;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setQuizOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [quizOpen]);

  function openQuiz() {
    // Hard guard — if the lock is set, ignore the click outright. The CTAs
    // also render differently when locked (see below) so this is belt+braces.
    if (alreadySubmitted) return;
    setCurrentStep(0);
    setSubmitted(false);
    setSubmitError(false);
    setQuizOpen(true);
  }

  function closeQuiz() {
    setQuizOpen(false);
  }

  const setAnswer = useCallback(
    (name: string, value: string, multi: boolean) => {
      setAnswers((prev) => {
        if (!multi) return { ...prev, [name]: value };
        const cur = Array.isArray(prev[name]) ? (prev[name] as string[]) : [];
        const next = cur.includes(value)
          ? cur.filter((v) => v !== value)
          : [...cur, value];
        return { ...prev, [name]: next };
      });
    },
    [],
  );

  function isValid(): boolean {
    if (!step.required) return true;
    const v = answers[step.name];
    if (!v) return false;
    return step.multi ? Array.isArray(v) && v.length > 0 : Boolean(v);
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(false);

    let customer: Record<string, string> = {};
    let orderInfo: Record<string, string | number> = {};
    let calendly: { eventUri?: string; inviteeUri?: string; scheduledAt?: string } = {};

    try {
      const raw = window.sessionStorage.getItem(clientConfig.funnel.customerStorageKey);
      if (raw) customer = JSON.parse(raw) as Record<string, string>;
    } catch {}
    try {
      const raw = window.sessionStorage.getItem(clientConfig.funnel.orderStorageKey);
      if (raw) orderInfo = JSON.parse(raw) as Record<string, string | number>;
    } catch {}
    try {
      const raw = window.sessionStorage.getItem("arjun_calendly");
      if (raw) calendly = JSON.parse(raw);
    } catch {}

    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer,
          orderId: orderInfo.orderId,
          paymentId: orderInfo.paymentId,
          calendly,
          answers,
        }),
      });
      if (!res.ok) throw new Error(`quiz submit failed: ${res.status}`);
      setSubmitted(true);
      // Lock the CTAs for the rest of this browser session so the user
      // can't double-submit by reopening the modal or refreshing the page.
      setAlreadySubmitted(true);
      try {
        window.sessionStorage.setItem(QUIZ_SUBMITTED_KEY, "1");
      } catch {
        // private mode / quota — non-fatal, in-memory state still locks the UI
      }
    } catch (err) {
      console.error("[quiz] submit failed", err);
      setSubmitError(true);
    } finally {
      setSubmitting(false);
    }
  }

  function handleNext() {
    if (submitted) return;
    if (!isValid()) {
      setShake(true);
      setTimeout(() => setShake(false), 500);
      return;
    }
    if (currentStep === total - 1) {
      void submit();
      return;
    }
    setCurrentStep((i) => Math.min(i + 1, total - 1));
  }

  function handleBack() {
    setCurrentStep((i) => Math.max(i - 1, 0));
  }

  const progress = ((currentStep + 1) / total) * 100;

  const heroVidRef = useRef<HTMLDivElement>(null);
  const heroFrameRef = useRef<HTMLIFrameElement>(null);

  /** Plays inline in its own frame — this page has no fullscreen trigger. */
  function playVideo() {
    if (videoPlaying) return;
    setVideoPlaying(true);
  }

  // Vimeo falls back to muted playback when the browser blocks unmuted
  // autoplay; tell the player to unmute once it reports ready.
  useEffect(() => {
    if (!videoPlaying) return;
    return forceUnmute(heroFrameRef.current);
  }, [videoPlaying]);

  return (
    <div className="af-root">
      {/* Header */}
      <header className="af-header">
        <div className="af-wrap">
          <Link
            href="/"
            className="af-logo"
            aria-label="Team Fit Arjun — home"
          >
            <span id="af-logo-mark" className="af-logo-mark">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/Site%20main%20logo.png"
                alt="TFA"
                className="af-logo-img"
              />
            </span>
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="ty-hero">
        <div className="af-wrap ty-hero-inner">
          <div className="ty-conf">
            <div className="ty-check" data-af-reveal aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6" /></svg>
            </div>
            <div className="ty-conf-text">
              <div className="ty-kicker" data-af-reveal style={{ "--d": ".05s" } as React.CSSProperties}>
                Booking Confirmed
              </div>
              <h1 className="ty-h1" data-af-reveal style={{ "--d": ".12s" } as React.CSSProperties}>
                Your Call With Arjun Is <span className="af-accent">Locked In.</span>
              </h1>
              <p className="ty-sub" data-af-reveal style={{ "--d": ".18s" } as React.CSSProperties}>
                Check your email for the confirmation and your prep checklist. We&rsquo;ll also WhatsApp
                you the meeting link before the call — save the number when it arrives, that&rsquo;s how we
                reach you.
              </p>
            </div>
          </div>

          <div className="ty-vframe" data-af-reveal style={{ "--d": ".24s" } as React.CSSProperties}>
            <div
              ref={heroVidRef}
              className={`ty-vid ${videoPlaying ? "playing" : ""}`}
              id="ty-vsl"
              role="button"
              aria-label="Play video"
              onClick={playVideo}
            >
              <div
                className={`ty-vthumb ${videoPlaying ? "" : "on"}`}
                id="ty-vthumb"
                style={{
                  backgroundImage: `url("${posterUrl}")`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  backgroundRepeat: "no-repeat",
                }}
              />
              {!videoPlaying ? (
                <div className="ty-vplay">
                  <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                </div>
              ) : (
                <iframe
                  ref={heroFrameRef}
                  src={buildVimeoSrc(HERO_VIDEO_URL)}
                  title="Your Blueprint Call — Arjun Shah"
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

          <div className="ty-form-cta" data-af-reveal style={{ "--d": ".3s" } as React.CSSProperties}>
            <div className="ty-donow">
              <div className="ty-donow-eyebrow">Do One Thing Right Now · Takes 30 Seconds</div>
              <p className="ty-donow-title">
                Message Arjun on Instagram and tell him one line: what made you book this call.
              </p>
              <p className="ty-donow-sub">
                He reads these personally before your session, so he walks in already knowing your
                situation instead of starting cold.
              </p>
              <InstagramCta id="ty-ig-open" />
            </div>

            <ol className="ty-steps">
              {[
                "Reply to the WhatsApp message when it arrives so we know we’ve reached you.",
                "Before the call, note down your last 2 or 3 attempts: what you tried, how long it lasted, where it broke.",
                "Take the call from a quiet place, camera on if possible. 30 focused minutes beats 45 distracted ones.",
              ].map((stepText, i) => (
                <li key={i}>
                  <span className="ty-step-num">{i + 1}</span>
                  {stepText}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* What this call section */}
      <section className="ty-call">
        <div className="af-narrow">
          <div data-af-reveal>
            <span className="ty-sec-label">
              What This Call Will <span className="acc">Actually</span> Do
            </span>
          </div>
          <h2 data-af-reveal style={{ "--d": ".06s" } as React.CSSProperties}>
            This is <span className="af-accent">not a generic consultation.</span>
          </h2>
          <p data-af-reveal style={{ "--d": ".12s" } as React.CSSProperties}>
            We&apos;ll look at how your{" "}
            <strong>food, routine, and lifestyle interact in real life</strong> —
            not how they look on paper.
          </p>
          <div className="ty-goal-box" data-af-reveal style={{ "--d": ".2s" } as React.CSSProperties}>
            <div className="lead">The goal is simple — clarity on:</div>
            <ul>
              <li>What&apos;s working in your current approach</li>
              <li>What&apos;s silently breaking your progress</li>
              <li>What needs to change going forward</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Appointment locked */}
      <section className="ty-appt">
        <div className="af-wrap">
          <div className="ty-appt-card" data-af-reveal>
            <div className="ty-appt-icon">
              <svg viewBox="0 0 24 24">
                <rect x="3" y="5" width="18" height="16" rx="2" />
                <line x1="16" y1="3" x2="16" y2="7" />
                <line x1="8" y1="3" x2="8" y2="7" />
                <line x1="3" y1="11" x2="21" y2="11" />
                <path d="M9 15l2 2 4-4" />
              </svg>
            </div>
            <h2>Your Appointment Is <span>Locked</span></h2>
            <p>Your 1:1 session has already been scheduled. The date and time you selected are confirmed.</p>
            <span className="ty-receive-lbl">What You&apos;ll Receive</span>
            <ul className="ty-receive">
              <li>
                <span className="ic">
                  <svg viewBox="0 0 24 24">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                    <polyline points="22,6 12,13 2,6" />
                  </svg>
                </span>
                <span className="tx">
                  Call Link via Email
                  <small>Delivered to your inbox</small>
                </span>
              </li>
              <li>
                <span className="ic">
                  <svg viewBox="0 0 24 24">
                    <circle cx="12" cy="13" r="8" />
                    <path d="M12 9v4l2 2" />
                    <path d="M5 3L2 6" />
                    <path d="M22 6l-3-3" />
                  </svg>
                </span>
                <span className="tx">
                  Reminder Before Session
                  <small>So you don&apos;t miss it</small>
                </span>
              </li>
            </ul>
            <div className="ty-join-note">
              Please join <strong>5 minutes before your scheduled time</strong> so we can start without delay.
            </div>
          </div>
        </div>
      </section>

      {/* Important policy */}
      <section className="ty-policy">
        <div className="af-wrap">
          <div className="ty-policy-card" data-af-reveal>
            <div className="ty-policy-head">
              <div className="ic">
                <svg viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <h2>
                Important
                <small>Please Read Once</small>
              </h2>
            </div>
            <p>
              This is a <strong>personalised, time-blocked session.</strong> Because of that:
            </p>
            <ul className="ty-policy-list">
              <li>No rescheduling</li>
              <li>No cancellations or refund-based adjustments</li>
              <li>Missed calls are treated as completed sessions</li>
            </ul>
            <div className="ty-policy-foot">
              <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              Your slot has been reserved specifically for you.
            </div>
          </div>
        </div>
      </section>

      {/* What to keep ready */}
      <section className="ty-ready">
        <div className="af-wrap">
          <div className="ty-ready-head" data-af-reveal>
            <h2>What To Keep Ready <span>Before The Call</span></h2>
            <p>To make the session meaningful, have this ready. You do <strong>not</strong> need perfect data.</p>
          </div>
          <div className="ty-ready-grid">
            <ReadyItem icon={<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>} title="Recent Blood Reports" body="If available. Any tests done in the last 6 months are helpful." />
            <ReadyItem delay=".08s" icon={<svg viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="14" r="2"/><path d="M8 14h.01M16 14h.01"/></svg>} title="Medications & Supplements" body="A quick list of what you're currently taking — including dosages." />
            <ReadyItem delay=".16s" icon={<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>} title="Daily Routine Snapshot" body="A simple picture of your day — wake time, work hours, sleep." />
            <ReadyItem icon={<svg viewBox="0 0 24 24"><path d="M3 11h18l-1.5 9H4.5L3 11z"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>} title="Typical Meals" body={"Home-cooked + outside food — what you actually eat, not what's \"ideal.\""} />
            <ReadyItem delay=".08s" icon={<svg viewBox="0 0 24 24"><path d="M6 4h12l-1 3H7L6 4z"/><path d="M7 7l2 13h6l2-13"/><path d="M9 12h6M9 16h6"/></svg>} title="Workout Pattern" body="Do you train? How often? What's working, what's frustrating you?" />
            <ReadyItem delay=".16s" icon={<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>} title="Open Mindset" body="Come with honesty about your patterns — not polished answers." />
          </div>
          <div className="ty-ready-callout" data-af-reveal>
            <p>
              We work with <em>real life</em> — not ideal conditions. Show up with what&apos;s true for you today.
            </p>
          </div>
        </div>
      </section>

      {/* Final note */}
      <section className="ty-final">
        <div className="af-wrap ty-final-inner">
          <h2 data-af-reveal>This Process Isn&apos;t About <em>Perfection.</em></h2>
          <p data-af-reveal style={{ "--d": ".1s" } as React.CSSProperties}>
            It&apos;s about three simple things that compound into real change:
          </p>
          <div className="ty-pillars">
            <Pillar delay=".16s" icon={<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/></svg>}>Observing<br />Patterns</Pillar>
            <Pillar delay=".22s" icon={<svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>}>Making Precise<br />Adjustments</Pillar>
            <Pillar delay=".28s" icon={<svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>}>Understanding<br />Your Body</Pillar>
          </div>
          <div className="ty-sign-off" data-af-reveal style={{ "--d": ".36s" } as React.CSSProperties}>
            <p>Show up honestly. Follow the process.</p>
            <p className="strong">Clarity will follow.</p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="af-foot">
        <div className="af-wrap">
          <div className="copy">© 2026 Arjun Fitness. All rights reserved.</div>
          <p>
            All content, systems and coaching services provided by Arjun Fitness Coaching are intended for educational and informational purposes only and do not guarantee specific results. This is not medical, legal or licensed professional advice. Always consult a qualified healthcare professional before making changes to your diet, exercise or lifestyle. Client results and testimonials vary based on individual factors such as consistency, medical history, lifestyle and adherence to the process. Outcomes are not typical or guaranteed. This website is not affiliated with or endorsed by Meta. FACEBOOK and INSTAGRAM are trademarks of Meta Platforms, Inc.
          </p>
          <p style={{ marginTop: 10 }}>Owned and operated by Arjun Shah.</p>
          <div className="links">
            <Link href="/privacy-policy">Privacy Policy</Link>
            <span className="sep">·</span>
            <Link href="/terms-and-conditions">Terms &amp; Conditions</Link>
            <span className="sep">·</span>
            <Link href="/refund-policy">Refund Policy</Link>
          </div>
        </div>
      </footer>

      {/* Sticky CTA */}
      <div
        className={`ty-sticky-cta ${stickyOn ? "is-visible" : ""}`}
        id="ty-sticky-cta"
        aria-hidden={!stickyOn}
      >
        <InstagramCta id="ty-sticky-trigger" />
      </div>

      {/* Quiz Modal — source CSS shows it via .qz-overlay.is-open */}
      <div
        className={`qz-overlay ${quizOpen ? "is-open" : ""}`}
        id="qz-overlay"
        aria-hidden={!quizOpen}
        role="dialog"
        aria-modal="true"
        aria-labelledby="qz-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeQuiz();
        }}
      >
        <div className="qz-modal" id="qz-modal">
          <button
            type="button"
            className="qz-close"
            id="qz-close"
            aria-label="Close form"
            onClick={closeQuiz}
          >
            <svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>

          <div className="qz-head">
            <p className="qz-eyebrow">CHHOD YAAR DIAGNOSTIC</p>
            <h2 className="qz-title" id="qz-title">
              {submitted ? "All done." : "A few questions before we speak."}
            </h2>
            {!submitted ? (
              <>
                <div className="qz-prog">
                  <div className="qz-prog-fill" id="qz-prog-fill" style={{ width: `${progress}%` }} />
                </div>
                <p className="qz-step-label" id="qz-step-label">
                  Question {currentStep + 1} of {total}
                </p>
              </>
            ) : null}
          </div>

          <div className="qz-body" id="qz-body">
            {submitted ? (
              <div className="qz-end is-active" id="qz-end">
                <div className="qz-end-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h3>Thanks for filling up the form.</h3>
                <p>See you on the call. Arjun will already have your context before you join.</p>
              </div>
            ) : (
              <div
                className={`qz-step is-active ${shake ? "qz-step-error" : ""}`}
                data-step={step.step}
                data-name={step.name}
                data-required={step.required ? "1" : undefined}
                data-multi={step.multi ? "1" : undefined}
              >
                <h3 className="qz-q">{step.question}</h3>
                {step.sub ? <p className="qz-q-sub">{step.sub}</p> : null}
                <div className="qz-opts">
                  {step.options.map((opt) => {
                    const current = answers[step.name];
                    const checked = step.multi
                      ? Array.isArray(current) && current.includes(opt.value)
                      : current === opt.value;
                    return (
                      <label
                        key={opt.value}
                        className={`qz-opt ${checked ? "is-checked" : ""}`}
                        data-multi={step.multi ? "1" : undefined}
                      >
                        <input
                          type={step.multi ? "checkbox" : "radio"}
                          name={`q${step.step}`}
                          value={opt.value}
                          checked={checked}
                          onChange={() => setAnswer(step.name, opt.value, !!step.multi)}
                        />
                        <span className="qz-mark" />
                        <span className="qz-opt-text">{opt.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {submitError ? (
              <div className="qz-error is-visible" id="qz-error">
                Something went wrong while sending. Please try again or email us directly.
              </div>
            ) : null}
          </div>

          {!submitted ? (
            <div className="qz-foot" id="qz-foot">
              <button
                type="button"
                className="qz-btn qz-btn-back"
                id="qz-back"
                disabled={currentStep === 0}
                onClick={handleBack}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ width: 13, height: 13 }}
                >
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                Back
              </button>
              <button
                type="button"
                className={`qz-btn qz-btn-next ${submitting ? "loading" : ""}`}
                id="qz-next"
                disabled={submitting}
                onClick={handleNext}
              >
                <span className="qz-spinner" />
                <span className="qz-next-label">
                  {currentStep === total - 1 ? "Submit" : "Next"}
                </span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ReadyItem({
  icon,
  title,
  body,
  delay,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  delay?: string;
}) {
  return (
    <div
      className="ty-ready-item"
      data-af-reveal
      style={delay ? ({ "--d": delay } as React.CSSProperties) : undefined}
    >
      <div className="ic">{icon}</div>
      <h4>{title}</h4>
      <p>{body}</p>
    </div>
  );
}

function Pillar({
  icon,
  delay,
  children,
}: {
  icon: React.ReactNode;
  delay?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="ty-pillar"
      data-af-reveal
      style={delay ? ({ "--d": delay } as React.CSSProperties) : undefined}
    >
      <div className="ic">{icon}</div>
      <h5>{children}</h5>
    </div>
  );
}

/**
 * Post-booking CTA — links straight to Arjun's Instagram so the user can
 * message him directly. Replaces the old "Chhod Yaar" diagnostic quiz form.
 */
function InstagramCta({ id }: { id: string }) {
  return (
    <a
      href={INSTAGRAM_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="af-cta ty-quiz-trigger"
      id={id}
    >
      <span>Message Arjun on Instagram</span>
      <span className="arrow">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12h14M13 5l7 7-7 7" />
        </svg>
      </span>
    </a>
  );
}

/**
 * The "Fill The Form" CTA. Renders differently once the user has submitted
 * the quiz in this session — becomes a static "Form Submitted" badge with no
 * click action. Lock is cleared on a new browser session (sessionStorage).
 */
function QuizTriggerButton({
  id,
  locked,
  onClick,
}: {
  id: string;
  locked: boolean;
  onClick: () => void;
}) {
  if (locked) {
    return (
      <div
        className="af-cta ty-quiz-trigger ty-quiz-trigger-done"
        id={id}
        role="status"
        aria-live="polite"
        aria-disabled="true"
      >
        <span>Form Submitted Successfully</span>
        <span className="arrow" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="af-cta ty-quiz-trigger"
      id={id}
      onClick={onClick}
    >
      <span>Fill The Form To Get Started</span>
      <span className="arrow">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12h14M13 5l7 7-7 7" />
        </svg>
      </span>
    </button>
  );
}
