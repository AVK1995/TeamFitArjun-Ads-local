"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { clientConfig } from "@/client.config";
import {
  readUtmFromStorage,
  readUtmFromSearch,
  utmToQueryString,
  readCookie,
} from "@/lib/utm";
import { setMetaAdvancedMatching } from "@/lib/analytics";
import { trackGa4EventOnce } from "@/lib/ga4";
import { fireConfetti } from "@/lib/confetti";
import type {
  CreateOrderResponse,
  CustomerPayload,
  UtmPayload,
} from "@/lib/types";
import type {
  RazorpayOptions,
  RazorpayPaymentResponse,
} from "@/lib/razorpay-window";
import { COUNTRIES, type Country } from "./countries";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Web Crypto SHA-256 (hex) — used to dedup the Meta CAPI `ic_event` by email. */
async function sha256Hex(value: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) return value;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface FormState {
  fname: string;
  lname: string;
  email: string;
  phone: string;
  town: string;
}

type FieldKey = keyof FormState;

function validateField(id: FieldKey, value: string): boolean {
  const v = value.trim();
  if (id === "fname" || id === "lname" || id === "town") return v.length >= 2;
  if (id === "email") return EMAIL_RE.test(v);
  if (id === "phone") {
    const d = v.replace(/\D/g, "");
    return d.length >= 6 && d.length <= 15;
  }
  return true;
}

function formatINR(n: number): string {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

export function CheckoutView() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>({
    fname: "",
    lname: "",
    email: "",
    phone: "",
    town: "",
  });
  // `touched` flags whether a field has been blurred — errors only show after blur
  const [touched, setTouched] = useState<Record<FieldKey, boolean>>({
    fname: false,
    lname: false,
    email: false,
    phone: false,
    town: false,
  });
  const [country, setCountry] = useState<Country>(COUNTRIES[0]);
  const [flagOpen, setFlagOpen] = useState(false);
  const [flagSearch, setFlagSearch] = useState("");
  const [couponOpen, setCouponOpen] = useState(false);
  // Collapsed by default so the form is reachable on mobile without scrolling
  // past the summary. Desktop forces it open via CSS and hides the toggle, so
  // this only affects mobile — where the user can still expand it.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [coupon, setCoupon] = useState<{ code: string; discount: number } | null>(null);
  const [couponInput, setCouponInput] = useState("");
  const [couponMsg, setCouponMsg] = useState<{ text: string; tone: "error" | "success" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [sdkReady, setSdkReady] = useState(false);
  const [offerTime, setOfferTime] = useState("15:00");
  const [changeCodeOpen, setChangeCodeOpen] = useState(false);
  const flagBoxRef = useRef<HTMLDivElement>(null);

  // Read UTM once on mount — used in API calls + Razorpay notes + Pabbly
  const utm = useMemo<UtmPayload>(() => {
    if (typeof window === "undefined") return {};
    const urlUtm = readUtmFromSearch(window.location.search);
    const stored = readUtmFromStorage(clientConfig.funnel.sessionStorageKey);
    return { ...stored, ...urlUtm };
  }, []);

  // Lazy-detect Razorpay SDK readiness (loaded via <Script> in layout.tsx)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.Razorpay) {
      setSdkReady(true);
      return;
    }
    const id = window.setInterval(() => {
      if (window.Razorpay) {
        setSdkReady(true);
        window.clearInterval(id);
      }
    }, 200);
    return () => window.clearInterval(id);
  }, []);

  // Confetti on arrival — this page is only reached by clicking a funnel CTA,
  // so the burst celebrates the "special offer unlocked" the moment it loads.
  useEffect(() => {
    fireConfetti();
  }, []);

  // Special-offer countdown. Loops back to full on reaching zero so the offer
  // never actually expires (matches the hero timer's behaviour).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const DURATION = clientConfig.offer.windowMinutes * 60 * 1000;
    let started = Date.now();
    const tick = () => {
      let remaining = started + DURATION - Date.now();
      if (remaining <= 0) {
        started = Date.now();
        remaining = DURATION;
      }
      const s = Math.floor(remaining / 1000);
      setOfferTime(
        `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`,
      );
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Reveal-on-scroll (matches data-af-reveal in the source HTML)
  useEffect(() => {
    if (!("IntersectionObserver" in window)) {
      document
        .querySelectorAll<HTMLElement>("[data-af-reveal]")
        .forEach((el) => el.classList.add("vis"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("vis");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12 },
    );
    document
      .querySelectorAll<HTMLElement>("[data-af-reveal]")
      .forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // Sticky pay bar is always visible on mobile (shown from first paint — not
  // gated on scroll) so the CTA is reachable the moment the page loads.

  // Close flag dropdown on outside click
  useEffect(() => {
    if (!flagOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (flagBoxRef.current && !flagBoxRef.current.contains(e.target as Node)) {
        setFlagOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [flagOpen]);

  const filteredCountries = useMemo(() => {
    const q = flagSearch.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) => c.name.toLowerCase().includes(q) || c.dial.includes(q),
    );
  }, [flagSearch]);

  function update<K extends FieldKey>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function fieldHasError(id: FieldKey): boolean {
    return touched[id] && !validateField(id, form[id]);
  }

  function validateAll(): boolean {
    setTouched({ fname: true, lname: true, email: true, phone: true, town: true });
    return (Object.keys(form) as FieldKey[]).every((k) => validateField(k, form[k]));
  }

  const collectCustomer = useCallback((): CustomerPayload => {
    const rawPhone = form.phone.trim();
    return {
      firstName: form.fname.trim(),
      lastName: form.lname.trim(),
      email: form.email.trim().toLowerCase(),
      phone: rawPhone ? `${country.dial}${rawPhone}` : "",
      countryCode: country.iso.toUpperCase(),
      city: form.town.trim(),
    };
  }, [form, country]);

  // Form-fill Manual Advanced Matching. As soon as every required field is
  // valid + filled, debounce 500ms then hash the identity, persist to the
  // arjun_mam cookie (30-day TTL), and re-init the Pixel with the hashed
  // matching object. Every subsequent PageView (this page, /book-a-call,
  // /thank-you, future visits) ships with em/ph/fn/ln/ct/country/external_id.
  useEffect(() => {
    const allFilled = (Object.keys(form) as FieldKey[]).every(
      (k) => form[k].trim().length > 0,
    );
    if (!allFilled) return;
    const allValid = (Object.keys(form) as FieldKey[]).every((k) =>
      validateField(k, form[k]),
    );
    if (!allValid) return;
    const customer = collectCustomer();
    const timer = window.setTimeout(() => {
      void setMetaAdvancedMatching({
        email: customer.email,
        phone: customer.phone,
        firstName: customer.firstName,
        lastName: customer.lastName,
        city: customer.city,
        country: customer.countryCode,
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [form, collectCustomer]);

  function applyCoupon() {
    const code = couponInput.trim();
    if (!code) {
      setCouponMsg({ text: "Please enter a coupon code", tone: "error" });
      return;
    }
    // Local-only acceptance for v1. Real validation can be added by
    // calling `/api/coupon` server-side and returning a discount amount.
    setCoupon({ code, discount: 0 });
    setCouponInput("");
    setCouponMsg(null);
  }

  function removeCoupon() {
    setCoupon(null);
    setCouponMsg(null);
  }

  const basePrice = clientConfig.pricing.price;
  const total = basePrice - (coupon?.discount ?? 0);
  const formattedTotal = formatINR(total);
  const formattedDiscount = formatINR(coupon?.discount ?? 0);

  // ── Special-offer box (display only — never changes what Razorpay charges) ──
  const offerOriginal = clientConfig.offer.originalPrice; // struck "before" price
  const offerSaving = Math.max(0, offerOriginal - basePrice); // "you save ₹X"
  const offerPct =
    offerOriginal > basePrice
      ? Math.round(((offerOriginal - basePrice) / offerOriginal) * 1000) / 10 // 1 dp
      : 0;
  const offerCode = clientConfig.offer.code;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // GA4 fires FIRST — before validation. Per GA4 brief v2.0, the signal
    // is "user attempted to pay", not "user submitted a valid form".
    // A half-filled bounce still counts. Deduped once-per-browser.
    trackGa4EventOnce("initiate_checkout");
    if (!validateAll()) {
      const firstBad = (Object.keys(form) as FieldKey[]).find(
        (k) => !validateField(k, form[k]),
      );
      if (firstBad) {
        document
          .getElementById(`f-${firstBad}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }
    if (!sdkReady || !window.Razorpay) {
      setCouponMsg({
        text: "Payment is loading — please wait a moment and try again.",
        tone: "error",
      });
      return;
    }
    setLoading(true);
    const customer = collectCustomer();
    // Meta CAPI `ic_event` (custom — the standard `InitiateCheckout` is
    // blocked on this H&W-restricted dataset) — fires ONCE per email per browser, right
    // before create-order + Razorpay open. Deduped by localStorage keyed on
    // sha256(email) so a different email in the same browser re-fires.
    // Failures never block payment; every step is best-effort.
    void (async () => {
      try {
        const emailNorm = customer.email.trim().toLowerCase();
        const emailHash = await sha256Hex(emailNorm);
        if (typeof window !== "undefined") {
          if (window.localStorage.getItem("arjun_ic_fired") === emailHash) {
            return;
          }
          const res = await fetch("/api/meta/initiate-checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              customer,
              eventSourceUrl: window.location.href,
            }),
            keepalive: true,
          });
          if (res.ok) {
            try {
              window.localStorage.setItem("arjun_ic_fired", emailHash);
            } catch {
              // private mode — non-fatal
            }
          }
        }
      } catch (err) {
        console.warn("[ic] client-side fire failed", err);
      }
    })();
    try {
      const orderRes = await fetch("/api/razorpay/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: basePrice,
          currency: clientConfig.pricing.currency,
          coupon: coupon?.code,
          customer,
          // utm + fbp go into Razorpay order notes server-side. The webhook
          // fallback reads notes back so it can fire Pabbly with the same
          // complete payload as verify-payment AND ship fbc+fbp to Meta
          // CAPI for EMQ — even if the browser dies before verify-payment
          // lands. fbc is derived from utm.fbclid on the server side; fbp
          // must be passed explicitly because it's a separate cookie
          // (random ID, not derivable from URL params).
          utm,
          fbp: readCookie("_fbp"),
        }),
      });
      if (!orderRes.ok) throw new Error(`create-order failed: ${orderRes.status}`);
      const order = (await orderRes.json()) as CreateOrderResponse;

      const options: RazorpayOptions = {
        key: order.keyId,
        amount: order.amount * 100,
        currency: order.currency,
        name: clientConfig.brand.name,
        description: clientConfig.razorpayModal.description,
        order_id: order.orderId,
        prefill: {
          name: `${customer.firstName} ${customer.lastName}`.trim(),
          email: customer.email,
          contact: customer.phone,
        },
        notes: {
          product: clientConfig.brand.productName,
          utm_source: utm.utm_source ?? "",
          utm_campaign: utm.utm_campaign ?? "",
          // Identity fields propagate into Razorpay order notes so the
          // webhook fallback (app/api/razorpay/webhook/route.ts) can still
          // build a full EMQ payload when the browser-driven verify-payment
          // path doesn't reach us (closed tab, network drop, etc).
          first_name: customer.firstName,
          last_name: customer.lastName,
          customer_email: customer.email,
          customer_phone: customer.phone,
          country_code: customer.countryCode,
          city: customer.city,
        },
        theme: { color: clientConfig.razorpayModal.themeColor },
        modal: { escape: true, ondismiss: () => setLoading(false) },
        handler: (response: RazorpayPaymentResponse) => {
          setRedirecting(true);
          // Refresh MAM (fire-and-forget — never block the redirect).
          void setMetaAdvancedMatching({
            email: customer.email,
            phone: customer.phone,
            firstName: customer.firstName,
            lastName: customer.lastName,
            city: customer.city,
            country: customer.countryCode,
          });

          // The Razorpay-signed webhook (app/api/razorpay/webhook/route.ts)
          // is the SOLE tracking authority — it fires Pabbly + Meta CAPI
          // server-to-server on payment.captured and covers UPI-app payers
          // who never return to this tab. The browser no longer POSTs to a
          // verify-payment route; we just persist the customer/order for
          // /thank-you and redirect.

          try {
            window.sessionStorage.setItem(
              clientConfig.funnel.customerStorageKey,
              JSON.stringify(customer),
            );
            window.sessionStorage.setItem(
              clientConfig.funnel.orderStorageKey,
              JSON.stringify({
                orderId: response.razorpay_order_id,
                paymentId: response.razorpay_payment_id,
                eventId: response.razorpay_payment_id,
                amount: basePrice,
                currency: clientConfig.pricing.currency,
              }),
            );
          } catch {
            // sessionStorage may be unavailable in private mode — fine, URL params cover it
          }

          const qs = utmToQueryString(utm);
          router.push(
            `/book-a-call?orderId=${encodeURIComponent(response.razorpay_order_id)}` +
              `&paymentId=${encodeURIComponent(response.razorpay_payment_id)}` +
              `&eventId=${encodeURIComponent(response.razorpay_payment_id)}${qs}`,
          );
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", (failure) => {
        setLoading(false);
        const qs = utmToQueryString(utm);
        router.push(
          `/payment-failed?reason=${encodeURIComponent(failure.error?.description ?? "Payment failed")}` +
            `&code=${encodeURIComponent(failure.error?.code ?? "")}${qs}`,
        );
      });
      rzp.open();
    } catch (err) {
      console.error("[checkout] order failed", err);
      setLoading(false);
      setCouponMsg({
        text: err instanceof Error ? err.message : "Could not start checkout. Try again.",
        tone: "error",
      });
    }
  }

  const phoneError = fieldHasError("phone");

  return (
    <div className="af-root">
      {/* SECTION 01 — Top Trust Bar */}
      <div className="co-trust-bar">
        <div className="af-wrap">
          <span className="itm">
            <svg viewBox="0 0 24 24">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Secure Checkout
          </span>
          <span className="sep" />
          <span className="itm">
            <svg viewBox="0 0 24 24">
              <path d="M12 2l8 3v7c0 4.97-3.35 9.26-8 10-4.65-.74-8-5.03-8-10V5l8-3z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            100% Refundable
          </span>
          <span className="sep" />
          <span className="itm">
            <svg viewBox="0 0 24 24">
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <path d="M2 10h20" />
              <path d="M6 15h4" />
            </svg>
            Razorpay Verified · 256-bit SSL
          </span>
        </div>
      </div>

      {/* SECTION 03 — Checkout Grid */}
      <section className="co-body">
        <div className="af-wrap">
          <div className="co-grid">
            {/* ===== LEFT: FORM ===== */}
            <form
              className="co-form"
              id="co-form"
              noValidate
              onSubmit={handleSubmit}
            >
              {/* UTM hidden inputs — populated from React state for parity with WP behavior */}
              <input type="hidden" name="utm_source" value={utm.utm_source ?? ""} readOnly />
              <input type="hidden" name="utm_medium" value={utm.utm_medium ?? ""} readOnly />
              <input type="hidden" name="utm_campaign" value={utm.utm_campaign ?? ""} readOnly />
              <input type="hidden" name="utm_content" value={utm.utm_content ?? ""} readOnly />
              <input type="hidden" name="utm_term" value={utm.utm_term ?? ""} readOnly />
              <input type="hidden" name="gclid" value={utm.gclid ?? ""} readOnly />
              <input type="hidden" name="fbclid" value={utm.fbclid ?? ""} readOnly />
              <input type="hidden" name="referrer" value={utm.referrer ?? ""} readOnly />
              <input type="hidden" name="landing_url" value={utm.landing_url ?? ""} readOnly />
              <input type="hidden" name="country_code" value={country.dial} readOnly />

              {/* ── Special-offer banner ── */}
              <div className="co-offer-banner" data-af-reveal>
                <span className="co-offer-ic" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="8" width="18" height="4" rx="1" />
                    <path d="M12 8v13" />
                    <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
                    <path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" />
                  </svg>
                </span>
                <div className="co-offer-banner-text">
                  <strong>You just unlocked a special offer!</strong>
                  <span>
                    Exclusive price applied just for you with code{" "}
                    <b className="co-offer-code">{offerCode}</b>
                  </span>
                </div>
              </div>

              {/* ── Special-offer box ── */}
              <div className="co-offer-box" data-af-reveal style={{ "--d": ".05s" } as React.CSSProperties}>
                <div className="co-offer-timer">
                  <span className="co-offer-timer-lbl">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 22h14M5 2h14M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4A2 2 0 0 0 17 6.2V2" />
                    </svg>
                    Offer may end in:
                  </span>
                  <span className="co-offer-timer-val">{offerTime}</span>
                </div>

                <div className="co-offer-unlocked">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="4" y="11" width="16" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 7.5-2" />
                  </svg>
                  Special Price Unlocked!
                </div>

                <div className="co-offer-price">
                  <div className="co-offer-price-left">
                    <span className="co-offer-was">{formatINR(offerOriginal)}</span>
                    <span className="co-offer-off">{offerPct}% OFF</span>
                  </div>
                  <span className="co-offer-now">{formatINR(basePrice)}</span>
                </div>

                <div className="co-offer-applied">
                  <span className="co-offer-applied-ic" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4.8a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8z" />
                      <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" />
                    </svg>
                  </span>
                  <span className="co-offer-applied-text">
                    <b>{offerCode}</b> applied — saving {formatINR(offerSaving)}
                  </span>
                </div>

                <button
                  type="button"
                  className="co-offer-change"
                  onClick={() => setChangeCodeOpen((v) => !v)}
                  aria-expanded={changeCodeOpen}
                >
                  {changeCodeOpen ? "Keep this offer" : "Change coupon code"}
                </button>

                {changeCodeOpen ? (
                  <div className="co-offer-change-row">
                    <input
                      type="text"
                      className="co-coupon-input"
                      placeholder="ENTER CODE"
                      autoComplete="off"
                      value={couponInput}
                      onChange={(e) => setCouponInput(e.target.value)}
                      onKeyDown={(e) => {
                        // Enter inside the form would submit → trigger payment.
                        if (e.key === "Enter") {
                          e.preventDefault();
                          applyCoupon();
                        }
                      }}
                    />
                    <button type="button" className="co-coupon-apply" onClick={applyCoupon}>
                      Apply
                    </button>
                  </div>
                ) : null}
                {couponMsg ? (
                  <p className={`co-coupon-msg ${couponMsg.tone}`}>{couponMsg.text}</p>
                ) : null}
              </div>

              <div className="co-card" data-af-reveal style={{ "--d": ".1s" } as React.CSSProperties}>
                <div className="co-step-head">
                  <div className="co-step-num">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 12.4a4.2 4.2 0 100-8.4 4.2 4.2 0 000 8.4z" />
                      <path d="M4.4 20.4a7.8 7.8 0 0115.2 0" />
                    </svg>
                  </div>
                  <div>
                    <p className="co-step-eyebrow">Secure Checkout</p>
                    <h2>Your Details</h2>
                    <p className="hint">We&apos;ll send your call link to these details.</p>
                  </div>
                </div>

                <div className="co-row">
                  <CoField
                    id="f-fname"
                    name="first_name"
                    label="First Name"
                    placeholder="Rahul"
                    autoComplete="given-name"
                    value={form.fname}
                    onChange={(v) => update("fname", v)}
                    onBlur={() => setTouched((p) => ({ ...p, fname: true }))}
                    hasError={fieldHasError("fname")}
                    errorMsg="Please enter your first name"
                  />
                  <CoField
                    id="f-lname"
                    name="last_name"
                    label="Last Name"
                    placeholder="Sharma"
                    autoComplete="family-name"
                    value={form.lname}
                    onChange={(v) => update("lname", v)}
                    onBlur={() => setTouched((p) => ({ ...p, lname: true }))}
                    hasError={fieldHasError("lname")}
                    errorMsg="Please enter your last name"
                  />
                </div>

                <div className="co-row-full">
                  <CoField
                    id="f-email"
                    name="email"
                    label="Email Address"
                    note="Call link comes here"
                    placeholder="rahul@example.com"
                    autoComplete="email"
                    inputMode="email"
                    type="email"
                    value={form.email}
                    onChange={(v) => update("email", v)}
                    onBlur={() => setTouched((p) => ({ ...p, email: true }))}
                    hasError={fieldHasError("email")}
                    errorMsg="Please enter a valid email address"
                  />
                </div>

                <div className="co-row-full">
                  <div
                    className={`co-field ${phoneError ? "has-error" : ""}`}
                    id="f-phone"
                  >
                    <label className="main" htmlFor="phone">
                      Phone Number <span className="req">*</span>
                      <span className="note">For WhatsApp reminders</span>
                    </label>
                    <div className="co-phone" ref={flagBoxRef} style={{ position: "relative" }}>
                      <button
                        type="button"
                        className={`co-flag-btn ${flagOpen ? "on" : ""}`}
                        id="flag-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setFlagOpen((v) => !v);
                          if (!flagOpen) setFlagSearch("");
                        }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          className="flag-img"
                          id="flag-img"
                          src={`https://flagcdn.com/w40/${country.iso}.png`}
                          srcSet={`https://flagcdn.com/w80/${country.iso}.png 2x`}
                          alt={country.iso.toUpperCase()}
                          width={26}
                          height={18}
                        />
                        <span className="code" id="flag-code">{country.dial}</span>
                        <svg className="caret" viewBox="0 0 24 24">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                      <input
                        type="tel"
                        className={`co-input ${form.phone && !phoneError ? "valid" : ""}`}
                        id="phone"
                        name="phone"
                        placeholder="9876543210"
                        autoComplete="tel-national"
                        inputMode="numeric"
                        required
                        value={form.phone}
                        onChange={(e) =>
                          update("phone", e.target.value.replace(/\D/g, ""))
                        }
                        onBlur={() => setTouched((p) => ({ ...p, phone: true }))}
                      />
                      <div
                        className={`co-flag-drop ${flagOpen ? "on" : ""}`}
                        id="flag-drop"
                      >
                        <div className="co-flag-search">
                          <input
                            type="text"
                            id="flag-search"
                            placeholder="Search country..."
                            autoComplete="off"
                            value={flagSearch}
                            onChange={(e) => setFlagSearch(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                setFlagOpen(false);
                              } else if (e.key === "Enter") {
                                const first = filteredCountries[0];
                                if (first) {
                                  setCountry(first);
                                  setFlagOpen(false);
                                  e.preventDefault();
                                }
                              }
                            }}
                          />
                        </div>
                        <div className="co-flag-list" id="flag-list">
                          {filteredCountries.length === 0 ? (
                            <div
                              style={{
                                padding: 16,
                                textAlign: "center",
                                color: "#847C6F",
                                fontSize: 13,
                              }}
                            >
                              No match
                            </div>
                          ) : (
                            filteredCountries.map((c) => (
                              <button
                                key={c.iso + c.dial}
                                type="button"
                                className="co-flag-opt"
                                onClick={() => {
                                  setCountry(c);
                                  setFlagOpen(false);
                                }}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  className="flag-img"
                                  src={`https://flagcdn.com/w40/${c.iso}.png`}
                                  srcSet={`https://flagcdn.com/w80/${c.iso}.png 2x`}
                                  alt={c.iso.toUpperCase()}
                                  width={24}
                                  height={16}
                                />
                                <span className="name">{c.name}</span>
                                <span className="dial">{c.dial}</span>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                    <p className="co-err">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      <span>Please enter a valid mobile number (6–15 digits)</span>
                    </p>
                  </div>
                </div>

                <div className="co-row-full" style={{ marginBottom: 4 }}>
                  <CoField
                    id="f-town"
                    name="town"
                    label="Town / City"
                    placeholder="Mumbai"
                    autoComplete="address-level2"
                    value={form.town}
                    onChange={(v) => update("town", v)}
                    onBlur={() => setTouched((p) => ({ ...p, town: true }))}
                    hasError={fieldHasError("town")}
                    errorMsg="Please enter your town or city"
                  />
                </div>

                <PaymentMethods />
              </div>
            </form>

            {/* ===== RIGHT: ORDER SUMMARY ===== */}
            <aside className="co-summary">
              <div
                className="co-card"
                data-af-reveal
                style={{ "--d": ".1s" } as React.CSSProperties}
              >
                <div className="co-sum-head">
                  <div className="bag">
                    <svg
                      viewBox="0 0 24 24"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M6 2l-2 5v13c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V7l-2-5H6z" />
                      <line x1="4" y1="7" x2="20" y2="7" />
                      <path d="M16 11a4 4 0 0 1-8 0" />
                    </svg>
                  </div>
                  <h3>Order Summary</h3>
                </div>

                <div className="co-prod">
                  <div className="co-prod-img" id="co-prod-img">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src="/checkout%20page%20product%20image.png"
                      alt={clientConfig.brand.productName}
                    />
                  </div>
                  <div className="co-prod-info">
                    <div className="co-prod-title">
                      <h4 id="co-prod-name">1:1 Blueprint Call with Arjun</h4>
                      <span className="co-prod-price">
                        <StruckPrice was={formatINR(offerOriginal)} now={formatINR(basePrice)} />
                      </span>
                    </div>
                    <button
                      type="button"
                      className={`co-more-toggle ${detailsOpen ? "is-open" : ""}`}
                      aria-expanded={detailsOpen}
                      aria-controls="co-prod-more"
                      onClick={() => setDetailsOpen((v) => !v)}
                    >
                      {detailsOpen ? "Hide details" : "Tap for more details"}
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Everything from here to the pay button collapses on mobile.
                    Forced open on desktop via CSS, so the state is mobile-only. */}
                <div className={`co-sum-collapse ${detailsOpen ? "on" : ""}`}>
                <div className="co-sum-collapse-inner">

                <div className={`co-prod-more ${detailsOpen ? "on" : ""}`} id="co-prod-more">
                  <div className="co-prod-more-inner">
                    <p className="co-more-eyebrow">Personalised Consultation · Refundable</p>
                    <ul className="co-more-list">
                      <li>Personalised Diagnosis &amp; Transformation Roadmap</li>
                      <li>
                        Walk-through of your Custom Execution Blueprint and 90-Day Transformation Plan
                      </li>
                      <li>
                        100% Results Guarantee: If you don’t see visible progress, we’ll continue coaching you until you do
                      </li>
                    </ul>
                  </div>
                </div>

                <div className="co-prices">
                  <div className="co-price-row sale">
                    <span className="lbl">Diagnostic Call</span>
                    <span className="val" id="co-sale-price">
                      <StruckPrice was={formatINR(offerOriginal)} now={formatINR(basePrice)} />
                    </span>
                  </div>
                  <div
                    className={`co-price-row discount ${coupon && coupon.discount > 0 ? "active" : ""}`}
                    id="co-discount-row"
                  >
                    <span className="lbl">Coupon Discount</span>
                    <span className="val" id="co-discount-val">
                      -{formattedDiscount}
                    </span>
                  </div>
                </div>

                <div className="co-coupon">
                  <button
                    type="button"
                    className={`co-coupon-toggle ${couponOpen ? "is-open" : ""}`}
                    id="co-coupon-toggle"
                    onClick={() => setCouponOpen((v) => !v)}
                  >
                    <span className="co-coupon-plus" aria-hidden="true">
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                      >
                        <line x1="8" y1="3.5" x2="8" y2="12.5" />
                        <line x1="3.5" y1="8" x2="12.5" y2="8" />
                      </svg>
                    </span>
                    <span className="co-coupon-label">Apply code</span>
                  </button>
                  <div
                    className={`co-coupon-box ${couponOpen ? "on" : ""}`}
                    id="co-coupon-box"
                  >
                    <div
                      className="co-coupon-row"
                      id="co-coupon-row"
                      style={{ display: coupon ? "none" : "flex" }}
                    >
                      <input
                        type="text"
                        className="co-coupon-input"
                        id="coupon"
                        name="coupon"
                        placeholder="ENTER CODE"
                        autoComplete="off"
                        value={couponInput}
                        onChange={(e) => setCouponInput(e.target.value)}
                      />
                      <button
                        type="button"
                        className="co-coupon-apply"
                        id="co-coupon-apply"
                        onClick={applyCoupon}
                      >
                        Apply
                      </button>
                    </div>
                    {coupon ? (
                      <div
                        className="co-coupon-applied on"
                        id="co-coupon-applied"
                        aria-live="polite"
                      >
                        <span className="ca-icon">
                          <svg viewBox="0 0 24 24">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </span>
                        <span className="ca-info">
                          <span className="ca-code" id="co-applied-code">
                            {coupon.code.toUpperCase()}
                          </span>
                          <span className="ca-saved" id="co-applied-saved">
                            {coupon.discount > 0
                              ? `You save ${formatINR(coupon.discount)}`
                              : "Code applied at checkout"}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="ca-remove"
                          id="co-coupon-remove"
                          aria-label="Remove coupon"
                          onClick={removeCoupon}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                          >
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ) : null}
                    {couponMsg ? (
                      <p
                        className={`co-coupon-msg ${couponMsg.tone}`}
                        id="co-coupon-msg"
                      >
                        {couponMsg.text}
                      </p>
                    ) : null}
                  </div>
                </div>

                </div>
                </div>
                {/* ↑ end .co-sum-collapse — pay button and below stay visible */}

                <button
                  type="submit"
                  form="co-form"
                  className={`co-pay-btn ${loading ? "loading" : ""}`}
                  disabled={loading}
                >
                  <span className="spinner" />
                  <span className="pay-lbl">
                    Pay <span className="co-pay-was">{formatINR(offerOriginal)}</span>{" "}
                    <span id="co-btn-amt" className="co-pay-now">{formattedTotal}</span> and Book My Call
                  </span>
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

                {/* Payment-security strip directly under the pay button */}
                <ul className="co-paytrust">
                  <li>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    256-bit SSL
                  </li>
                  <li>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2.5l7.5 2.8v6.4c0 4.6-3.1 8.6-7.5 9.3-4.4-.7-7.5-4.7-7.5-9.3V5.3L12 2.5z" />
                      <path d="M8.8 12.1l2.2 2.2 4.2-4.4" />
                    </svg>
                    PCI Compliant
                  </li>
                  <li>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12a9 9 0 1 0 3-6.7" />
                      <path d="M3 4v4.5h4.5" />
                    </svg>
                    100% Refundable
                  </li>
                </ul>

                <div
                  className={`co-redirect ${redirecting ? "on" : ""}`}
                  id="co-redirect"
                >
                  <span>Redirecting to secure payment</span>
                  <span className="dots">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </section>

      {/* SECTION 04 — Sticky Mobile Pay CTA */}
      <div className="co-sticky on" id="co-sticky">
        <div className="co-sticky-inner">
          <button
            type="submit"
            form="co-form"
            className={`co-pay-btn ${loading ? "loading" : ""}`}
            disabled={loading}
          >
            <span className="spinner" />
            <span className="pay-lbl">
              Pay <span className="co-pay-was">{formatINR(offerOriginal)}</span>{" "}
              <span id="co-sticky-amt" className="co-pay-now">{formattedTotal}</span> &amp; Book Your Slot
            </span>
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
        </div>
      </div>
    </div>
  );
}

/* ─── Struck "before" price + current price (e.g. ₹999  ₹97) ─── */
function StruckPrice({ was, now }: { was: string; now: string }) {
  return (
    <span className="co-struck">
      <span className="co-struck-was">{was}</span>
      <span className="co-struck-now">{now}</span>
    </span>
  );
}

/* ─── Accepted-payment-methods badge strip (moved out of the summary) ─── */
function PaymentMethods() {
  return (
                <div className="co-pm">
                  <span className="lbl">Accepted Payment Methods</span>
                  <span className="pm-badge" title="UPI">
                    <svg viewBox="0 0 30 14" xmlns="http://www.w3.org/2000/svg">
                      <rect width="30" height="14" rx="2" fill="#0C3F8C" />
                      <text
                        x="15"
                        y="10"
                        fontFamily="Arial, sans-serif"
                        fontWeight="900"
                        fontSize="8"
                        fill="#fff"
                        textAnchor="middle"
                        letterSpacing="0.5"
                      >
                        UPI
                      </text>
                    </svg>
                  </span>
                  <span className="pm-badge" title="Visa">
                    <svg viewBox="0 0 34 14" xmlns="http://www.w3.org/2000/svg">
                      <rect width="34" height="14" rx="2" fill="#1A1F71" />
                      <text
                        x="17"
                        y="10"
                        fontFamily="Arial, sans-serif"
                        fontWeight="900"
                        fontStyle="italic"
                        fontSize="8"
                        fill="#fff"
                        textAnchor="middle"
                      >
                        VISA
                      </text>
                    </svg>
                  </span>
                  <span className="pm-badge" title="Mastercard">
                    <svg viewBox="0 0 32 14" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="13" cy="7" r="5" fill="#EB001B" />
                      <circle cx="19" cy="7" r="5" fill="#F79E1B" fillOpacity="0.85" />
                    </svg>
                  </span>
                  <span className="pm-badge" title="RuPay">
                    <svg viewBox="0 0 38 14" xmlns="http://www.w3.org/2000/svg">
                      <rect width="38" height="14" rx="2" fill="#097939" />
                      <text
                        x="19"
                        y="10"
                        fontFamily="Arial, sans-serif"
                        fontWeight="900"
                        fontSize="7"
                        fill="#fff"
                        textAnchor="middle"
                        letterSpacing="0.3"
                      >
                        RuPay
                      </text>
                    </svg>
                  </span>
                  <span className="pm-badge" title="Net Banking">
                    <svg
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ color: "var(--brand)" }}
                    >
                      <rect x="1" y="3" width="12" height="8" rx="1" />
                      <path d="M1 6h12" />
                      <path d="M4 8.5v.5M7 8.5v.5M10 8.5v.5" />
                    </svg>
                    NET&nbsp;BANKING
                  </span>
                  <span className="pm-badge" title="Wallets">
                    <svg
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ color: "var(--brand)" }}
                    >
                      <rect x="1" y="4" width="12" height="8" rx="1.2" />
                      <path d="M10 4V2.5a1.5 1.5 0 0 0-3 0V4" />
                      <circle cx="10" cy="8" r="0.8" />
                    </svg>
                    WALLETS
                  </span>
                </div>
  );
}

/* ─── Standard text field (matches the .co-field markup from source) ─── */

interface CoFieldProps {
  id: string;
  name: string;
  label: string;
  note?: string;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  inputMode?: "text" | "email" | "numeric" | "tel" | "url" | "search";
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  hasError: boolean;
  errorMsg: string;
}

function CoField({
  id,
  name,
  label,
  note,
  placeholder,
  type = "text",
  autoComplete,
  inputMode,
  value,
  onChange,
  onBlur,
  hasError,
  errorMsg,
}: CoFieldProps) {
  const inputId = name;
  return (
    <div className={`co-field ${hasError ? "has-error" : ""}`} id={id}>
      <label className="main" htmlFor={inputId}>
        {label} <span className="req">*</span>
        {note ? <span className="note">{note}</span> : null}
      </label>
      <input
        type={type}
        className={`co-input ${value && !hasError ? "valid" : ""}`}
        id={inputId}
        name={name}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      <p className="co-err">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>{errorMsg}</span>
      </p>
    </div>
  );
}
