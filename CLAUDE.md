# CLAUDE.md — Arjun Blueprint Funnel

> **Do not give any output until you are 90% confident yourself.**
> Read the file. Confirm the path exists. Trace the data flow. Then answer.

This file is the orientation doc for any AI agent (or new engineer) touching this repo. Read it end-to-end before editing anything — the funnel is wired with a strict dedup contract and breaking it silently corrupts ad attribution and revenue numbers.

---

## 1. The client (TeamFitArjun)

- **Coach:** Arjun (`@thefitarjun` on Instagram), Indian fitness coach for working professionals.
- **Product:** "Custom Execution Blueprint Call" — a paid 30-minute 1:1 diagnostic call (₹97 INR, flat). No order bumps, no upsells, no add-ons. Single SKU.
- **Domain:** teamfitarjun.com
- **Support email:** support@teamfitarjun.com
- **Goal of the funnel:** convert cold Meta/Instagram ad traffic → paid Blueprint Call booking, while feeding Meta ads a clean, deduplicated, high-EMQ custom `sales` signal so the ad algorithm optimises correctly.

All client-facing values (brand name, price, Calendly URL, support email, content IDs) live in [client.config.ts](client.config.ts) — change there, do **not** hardcode anywhere else.

---

## 2. Funnel flow (the golden path)

```
Landing (/)
   ↓ click CTA → sendBeacon → /api/meta/add-to-cart → CAPI `atc_event` (server-only)
Checkout (/checkout)
   ↓ fills name/email/phone/country → Razorpay modal opens
   ↓ click Pay → /api/meta/initiate-checkout → CAPI `ic_event` (server-only)
   ↓ payment success (Razorpay handler) → browser redirects to /book-a-call
   ↓ (Razorpay POSTs payment.captured → /api/razorpay/webhook: HMAC verify, funnel gate, fires Pabbly + CAPI)
Book-a-call (/book-a-call)
   ↓ Calendly inline widget → user picks slot → postMessage event
Thank-you (/thank-you)
   ↓ NO browser conversion event — `sales` already fired server-side from the webhook
   ↓ shows post-purchase "Chhod Yaar" quiz → POSTs to /api/quiz → Pabbly

Failure branch: Razorpay error → /payment-failed → retry CTA + issue-report form
```

---

## 3. The Meta tracking contract (do not break)

### 3z. ⚠️ Health & Wellness restriction — ALL CAPI EVENTS ARE CUSTOM (read first)

This dataset is categorised **"Health and wellness condition"** in Events Manager. Meta's restriction blocks mid/lower-funnel **standard events by name** (`Purchase`, `AddToCart`, `InitiateCheckout`, `Subscribe`, `Lead`). Confirmed **custom** events with PHI-free payloads are not in that bucket and keep flowing + optimising.

Every server event therefore uses a custom name, defined once in `clientConfig.capi.events`:

| Funnel step | Standard name (BANNED) | Custom name we fire |
|---|---|---|
| Landing CTA click | ~~`AddToCart`~~ | **`atc_event`** |
| Pay clicked on /checkout | ~~`InitiateCheckout`~~ | **`ic_event`** |
| Paid order | ~~`Purchase`~~ | **`sales`** |

Companion rules that keep the custom events from being scanned and filtered as sensitive:
- **`custom_data` stays neutral** — `value` / `currency` / `payment_id` only. Never `content_name`, `content_ids`, `content_type`, product or category strings. (`clientConfig.capi.contentId/contentName/contentCategory` are deliberately NOT sent.)
- **`event_source_url` is truncated to origin** via `toOriginOnly()` in [lib/request.ts](lib/request.ts) — Meta's "core setup" tier strips the path anyway; sending it only leaks UTMs and path segments.
- **Campaigns optimise on the custom events directly.** A Custom Conversion built on top gives no bypass advantage — it is the same "custom" data.
- Do **not** re-add a standard event name anywhere. It re-triggers the block.

The rest of Section 3 describes the mechanics; the names above override any older `Purchase` references.

### 3a. Browser fires ONE event: `PageView`
Fired automatically from the inline script in [app/layout.tsx](app/layout.tsx) on every page load. The script reads the `arjun_mam` cookie (written by /checkout's form-fill `useEffect`, 30-day TTL) and calls `fbq('init', PIXEL_ID, mam)` BEFORE `fbq('track', 'PageView')`. Result: PageView ships with hashed `em, ph, fn, ln, ct, country, external_id` for any visitor whose identity we've ever captured — including cold returns within 30 days.

**No other browser events fire from this codebase.** No `Purchase`, `InitiateCheckout`, `Lead`, `ViewContent`. Auto Event Detection and Automatic Advanced Matching must be **OFF** in Events Manager.

### 3b. Server fires ONE event per paid order: `sales`
From [app/api/razorpay/webhook/route.ts](app/api/razorpay/webhook/route.ts) — the SOLE authority for the paid conversion. Razorpay POSTs `payment.captured` server-to-server, the webhook HMAC-verifies, gates on `notes.funnel`, then fires. `event_id = Razorpay payment_id`. `sales` is both the campaign optimisation target and the internal source-of-truth count — the standard `Purchase` that used to be paired with it was removed under the H&W restriction (Section 3z). `claimEventId()` in [lib/dedup.ts](lib/dedup.ts) + persistent `pabbly_fired`/`capi_fired` markers on Razorpay payment notes guard against Razorpay's own webhook retries. The browser NEVER fires Pabbly or CAPI; there is no verify-payment route.

### 3b-ii. Server also fires two upper-funnel intent events
Both from [lib/meta-events.ts](lib/meta-events.ts), each behind its own route and its own client-side dedup flag:

| Event | Route | Trigger | Dedup |
|---|---|---|---|
| `atc_event` | [/api/meta/add-to-cart](app/api/meta/add-to-cart/route.ts) | any landing CTA click (`sendBeacon` from [app/LandingView.tsx](app/LandingView.tsx)) | `localStorage.arjun_atc_fired` + `event_id = sha256(fbp\|atc)` |
| `ic_event` | [/api/meta/initiate-checkout](app/api/meta/initiate-checkout/route.ts) | Pay clicked on /checkout, after validation | `localStorage.arjun_ic_fired` (per email) + `event_id = sha256(email\|ic)` |

Both gate on production host + paid amount via [lib/tracking-gate.ts](lib/tracking-gate.ts). `ic_event` ships the full hashed identity payload; `atc_event` ships context only (no identity exists yet). `external_id` on `ic_event` uses the same `sha256(email)` derivation as `sales` so Meta stitches intent and purchase into one user.

Free orders (`clientConfig.pricing.price === 0`) **skip CAPI** — we never report zero-revenue conversions.

### 3c. EMQ contract (target ≥ 9.5)
Every server event ships:
- **Hashed** (SHA-256 of lowercase+trim, see [lib/hash.ts](lib/hash.ts)): `em, ph, fn, ln, ct, country, external_id`
- **Raw context**: `client_ip_address, client_user_agent, fbp, fbc`
- **custom_data**: `currency, value, payment_id` — and nothing else, ever (Section 3z)

`external_id` is derived as `sha256(normalised_email)` — the **same value** the browser MAM cookie stores. Meta requires `external_id` consistency across channels for the same user; this delivers it.

### 3d. Manual Advanced Matching (MAM) — the identity pipeline
- **Module:** [lib/analytics.ts](lib/analytics.ts) — `setMetaAdvancedMatching()`, `reapplyMamFromCookie()`. Hashes via Web Crypto (SHA-256), persists to first-party cookie `arjun_mam` (30-day TTL, `SameSite=Lax`).
- **Call site #1:** [app/checkout/CheckoutView.tsx](app/checkout/CheckoutView.tsx) — `useEffect` watching the form; when every required field is filled + valid, debounces 500ms then calls `setMetaAdvancedMatching`. Also called again right before `router.push('/book-a-call')` to refresh with the values that actually paid.
- **Call site #2:** [app/layout.tsx](app/layout.tsx) inline script — reads the cookie on every page load, applies it before PageView.
- **Call site #3:** [app/thank-you/ThankYouView.tsx](app/thank-you/ThankYouView.tsx) `useEffect` — `reapplyMamFromCookie()` as a safety net.

---

## 4. Tech stack

- **Next.js 15.5** (App Router) + **React 19** + **TypeScript 5.7**
- **Razorpay** (`razorpay` SDK + `checkout.js` lazy-loaded in [app/layout.tsx](app/layout.tsx)) — payments, INR only
- **Meta Pixel** (browser, PageView only with MAM) + **Meta Conversions API v25.0** (server, custom events only: `atc_event` / `ic_event` / `sales`)
- **Pabbly Connect** — webhook target for CRM/email/Sheets automation (purchase, quiz, payment-issue)
- **Calendly** inline widget — booking step
- **libphonenumber-js** (lazy) — phone normalisation for hashing
- **sharp** (devDep) — Next image optimisation
- No DB, no auth, no ORM. State is `sessionStorage` + first-party cookies (`arjun_mam`) + URL params + Razorpay/Pabbly as external systems of record.

---

## 5. Repo map (read these to understand any change)

### Pages — `app/`
- [app/layout.tsx](app/layout.tsx) — fonts, Meta Pixel `init` script, GA4, Razorpay `checkout.js` lazy load. Pixel does NOT auto-fire PageView; pages do it themselves so `eventID` can be passed.
- [app/page.tsx](app/page.tsx) + [app/LandingView.tsx](app/LandingView.tsx) — landing, fires `ViewContent`
- [app/checkout/page.tsx](app/checkout/page.tsx) + [app/checkout/CheckoutView.tsx](app/checkout/CheckoutView.tsx) — form, Razorpay modal, country picker ([app/checkout/countries.ts](app/checkout/countries.ts)), triggers server CAPI `ic_event`
- [app/book-a-call/page.tsx](app/book-a-call/page.tsx) + [app/book-a-call/BookACallView.tsx](app/book-a-call/BookACallView.tsx) — Calendly iframe, listens for `calendly.event_scheduled` postMessage → redirects to `/thank-you`
- [app/thank-you/page.tsx](app/thank-you/page.tsx) + [app/thank-you/ThankYouView.tsx](app/thank-you/ThankYouView.tsx) — no conversion event (server already fired `sales`); re-applies MAM and renders [app/thank-you/quizQuestions.ts](app/thank-you/quizQuestions.ts) quiz
- [app/payment-failed/](app/payment-failed/) — retry + issue-report
- [app/privacy-policy/](app/privacy-policy/) · [app/terms-and-conditions/](app/terms-and-conditions/) · [app/refund-policy/](app/refund-policy/) — legal

### API — `app/api/`
- [app/api/razorpay/create-order/route.ts](app/api/razorpay/create-order/route.ts) — creates Razorpay order; validates amount against `clientConfig.pricing.price`.
- [app/api/razorpay/webhook/route.ts](app/api/razorpay/webhook/route.ts) — Razorpay-signed webhook (`payment.captured`). The SOLE tracking authority: HMAC-verifies, reads `notes.funnel` to reject payments from other funnels sharing this Razorpay account, deduplicates via `claimEventId(payment_id)` + persistent payment-notes markers, then fires CAPI `[sales]` (custom-only, `event_id = payment_id`) + the Pabbly purchase webhook. Recovers `fbp` from order notes and rebuilds `fbc` from `fbclid`.
- [app/api/quiz/route.ts](app/api/quiz/route.ts) — forwards Chhod Yaar quiz answers to Pabbly (separate URL via `PABBLY_QUIZ_WEBHOOK_URL`).
- [app/api/payment-issue/route.ts](app/api/payment-issue/route.ts) — forwards retry / failure reports to Pabbly.

### Lib — `lib/`
- [lib/analytics.ts](lib/analytics.ts) — client MAM module: hashes form values via Web Crypto, writes `arjun_mam` cookie, calls `fbq('init', PIXEL_ID, mam)` so future PageViews ship hashed identity
- [lib/capi.ts](lib/capi.ts) — Meta CAPI client v25.0; emits N events in one POST (used as `[sales]` for paid orders); EMQ ≥ 9.5 payload
- [lib/razorpay.ts](lib/razorpay.ts) — SDK singleton + payment + webhook signature verify
- [lib/pabbly.ts](lib/pabbly.ts) — webhook payload builder, UTM passthrough
- [lib/dedup.ts](lib/dedup.ts) — in-memory `claimEventId()` lock (server)
- [lib/hash.ts](lib/hash.ts) — SHA-256 + Meta-spec lowercase/trim/digits normalisation
- [lib/utm.ts](lib/utm.ts) — `sessionStorage` UTM persistence + `fbc` synth from `?fbclid=`
- [lib/request.ts](lib/request.ts) — extract IP / UA / referer from Next `Request`
- [lib/seo.ts](lib/seo.ts) — per-page `metadata` builder
- [lib/types.ts](lib/types.ts) — shared API contract types (`CreateOrderRequest`, `CustomerPayload`, etc.)

### Other
- [components/UtmCapture.tsx](components/UtmCapture.tsx) — mounted on every page, writes `sessionStorage.arjun_utm` and landing_url
- [client.config.ts](client.config.ts) — single source of truth for brand/pricing/Calendly/CAPI knobs
- [.env.local.example](.env.local.example) — every required env var with comments; copy to `.env.local`

---

## 6. Client-side persistence

### sessionStorage (cleared on tab close)
- `arjun_utm` — UTM params + `fbclid` + `landing_url`, written by [components/UtmCapture.tsx](components/UtmCapture.tsx)
- `arjun_customer` — name/email/phone/country payload held between checkout → thank-you
- `arjun_order` — `{ orderId, paymentId, eventId, amount, currency }` carried to /thank-you for quiz submission
- `arjun_quiz_submitted` — guard against re-submitting the post-purchase quiz on refresh

Keys are defined in `clientConfig.funnel.*` — never hardcode.

### First-party cookies (persist 30 days)
- `arjun_mam` — JSON of hashed `{ em, ph, fn, ln, ct, country, external_id }`. Written by [lib/analytics.ts](lib/analytics.ts) `setMetaAdvancedMatching()`. Read by the inline script in [app/layout.tsx](app/layout.tsx) before every PageView. `SameSite=Lax`, `Path=/`.

### Meta-managed cookies
- `_fbp`, `_fbc` — set by `fbevents.js`. Read on the server when firing CAPI to maximise EMQ.

---

## 7. Running the project

```bash
npm install
cp .env.local.example .env.local   # fill in RAZORPAY_*, PABBLY_*, META_* values
npm run dev                         # http://localhost:3000
npm run build && npm start          # prod
npm run typecheck                   # tsc --noEmit
npm run lint                        # next lint
```

Use Razorpay test keys (`rzp_test_…`) + test card `4111 1111 1111 1111` for local. Set `META_CAPI_TEST_EVENT_CODE` while verifying in Events Manager → Test Events; **leave empty in prod**.

Env vars live in **one file**: `.env.local`. There is no `.env.local.example` — copy the keys listed in the file's comments. `NEXT_PUBLIC_META_PIXEL_ID` is read by both server (CAPI) and browser (Pixel) — single source. `META_CAPI_ACCESS_TOKEN` is server-only (no `NEXT_PUBLIC_` prefix).

---

## 8. Common pitfalls (read before "fixing" anything)

- Do NOT add ANY standard Meta event name (`Purchase`, `AddToCart`, `InitiateCheckout`, `Lead`, `ViewContent`, `Subscribe`) anywhere, browser or server. The dataset is H&W-restricted and Meta blocks them by name — see Section 3z. Event names live in `clientConfig.capi.events`.
- Do NOT add browser-side conversion events. The funnel fires exactly ONE browser event: `PageView`, from the layout inline script. Conversion is server-only.
- Do NOT add `content_name` / `content_ids` / `content_type` / product or category strings to any CAPI `custom_data`. That is what gets a custom event scanned and filtered as sensitive.
- Do NOT send a full URL as `event_source_url` — route it through `toOriginOnly()`.
- Do NOT change the `event_id` source. It is the Razorpay `payment_id`. Meta's 48h dedup depends on it, and Razorpay's webhook retries (for non-2xx responses) rely on it to collapse duplicates.
- Do NOT rename the `arjun_mam` cookie without updating the regex in the inline script in [app/layout.tsx](app/layout.tsx) AND the constant in [lib/analytics.ts](lib/analytics.ts).
- Do NOT hardcode the price — it's read from `NEXT_PUBLIC_PRICE` so server, browser, Razorpay, CAPI and Pabbly all stay in sync.
- Do NOT change a sessionStorage key without updating `clientConfig.funnel.*` and every reader.
- If a value belongs to the brand (name, email, Calendly URL, Instagram handle), it goes in [client.config.ts](client.config.ts).
- The webhook ([app/api/razorpay/webhook/route.ts](app/api/razorpay/webhook/route.ts)) is the sole tracking authority. It MUST remain idempotent via `claimEventId()` + the `pabbly_fired`/`capi_fired` markers on Razorpay payment notes — Razorpay retries webhooks on any non-2xx response, so a duplicate delivery is normal, not an error.
- In Events Manager: **Auto Event Detection OFF**, **Automatic Advanced Matching OFF**. Our code is the only event source and ships its own (manual) advanced matching via the cookie.
