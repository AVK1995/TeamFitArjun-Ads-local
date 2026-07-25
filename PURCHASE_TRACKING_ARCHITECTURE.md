# Purchase Tracking Architecture — Reliability Reference

> Hand this doc to any AI agent / engineer working on a sibling funnel
> (Razorpay → Pabbly + Meta CAPI). It captures the **brain logic**: what
> data goes where, when each event fires, how no lead is ever lost, and
> how no event is ever fired twice for the same lead.
>
> This is NOT a copy-paste-the-code doc. It's an architecture spec. The
> other funnel likely already has a working Razorpay → Pabbly path. The
> goal is to ELEVATE that funnel to this reliability + dedup standard
> without throwing away what already works.

---

## ⚠️ Part 0 — Event-name override (this funnel is Health & Wellness-restricted)

This dataset is categorised **"Health and wellness condition"** in Events Manager. Meta blocks mid/lower-funnel **standard events by name**, so **every CAPI event this funnel fires is a custom event.** Wherever the rest of this doc says `Purchase`, read `sales`:

| Funnel step | Standard name (BANNED here) | What we actually fire |
|---|---|---|
| Landing CTA click | ~~`AddToCart`~~ | `atc_event` |
| Pay clicked on /checkout | ~~`InitiateCheckout`~~ | `ic_event` |
| Paid order | ~~`Purchase`~~ | `sales` (single event, was `[Purchase, sales]`) |

Names are defined once in `clientConfig.capi.events`. Companion rules: `custom_data` carries `value`/`currency`/`payment_id` **only** (no `content_name`/`content_ids`/`content_type`), and `event_source_url` is truncated to origin via `toOriginOnly()`. Campaigns optimise on the custom events directly.

**Everything else in this doc — the dedup contract, the delivery-reliability design, the EMQ payload — is unchanged.** A sibling funnel that is NOT restricted should use the standard names as written below.

---

## Part 1 — The problem this architecture solves

Naive implementations of post-purchase tracking **silently lose 30-70% of mobile conversions**. Three root causes, observed in production:

1. **`void fetch(...)` gets killed by Vercel** as soon as the route handler returns its response. The Pabbly POST never completes. No error log appears on either side. Pabbly receives nothing.
2. **Mobile browsers kill tabs aggressively** between Razorpay's payment-success callback and our browser-side `verify-payment` fetch resolving. iOS Safari background-kills tabs in seconds; Android Chrome is almost as aggressive.
3. **In-memory dedup locks don't span Lambda functions.** Each Next.js API route runs as its own Vercel serverless function with its own memory. A `Map`-based claim lock in `/api/verify-payment` is invisible to `/api/webhook`.

Symptoms observed in production: 5 of 12 leads silently dropped from Pabbly while Meta CAPI succeeded; webhook fallback fired with sparse data (phone + email only, no first_name/UTMs). Root cause was a combination of all three above.

This architecture eliminates all three.

---

## Part 2 — Architecture at a glance

### Delivery — 3 layers of redundancy

```
Successful Razorpay payment
│
├── Layer 1 (PRIMARY): /api/razorpay/verify-payment
│     Browser-driven via fetch(..., { keepalive: true }).
│     Server AWAITS Pabbly + CAPI fires before responding.
│     Covers ~99% of conversions including most mobile.
│
├── Layer 2 (BACKUP): /api/razorpay/webhook
│     Razorpay server-to-server, arrives 5-30s after payment.captured.
│     Reads order notes (set at create-order) for full payload.
│     Covers the remaining ~1% where browser died before keepalive flushed.
│
└── Layer 3 (BACKUP-OF-BACKUP): scripts/backfill-pabbly.mjs
      Manual recovery script run from terminal. Pulls captured Razorpay
      payments in a date range, fires Pabbly. For the once-in-a-blue-moon
      case where both above fail (e.g. Pabbly is down for 30+ minutes).
```

### Dedup — 4 layers of guarantees

```
Layer 0 (Meta-side, passive): Meta CAPI dedupes by event_id within 48h.
                              Backstop only. Never relied on.

Layer 1 (in-process):         claimEventId() in lib/dedup.ts.
                              Catches refresh/retry on same warm Lambda.
                              0ms overhead. PER-INSTANCE only — does NOT
                              span routes.

Layer 2 (persistent):         Razorpay payment notes carry TWO separate
                              markers — pabbly_fired and capi_fired.
                              Read by both routes before firing; written
                              after each individual success. Survives
                              across Lambdas, regions, restarts.

Layer 3 (browser):            window.__arjun_last_pv token suppresses
                              same-pathname PageView fires <1s apart.
                              Defends against React StrictMode and any
                              future accidental fbq() calls.
```

**Pabbly + CAPI markers are independent** — if Pabbly fails but CAPI succeeds, only `capi_fired` is set. The fallback retries just Pabbly. No wasted retries.

---

## Part 3 — The data flow, end-to-end

```
User browses funnel
   │
   │ UtmCapture component writes UTM + fbclid + landing_url to sessionStorage
   │ MAM form-fill useEffect writes arjun_mam cookie (hashed em/ph/fn/ln/ct/country/external_id)
   │
   ▼
User submits checkout form → CheckoutView.handleSubmit
   │
   │ POST /api/razorpay/create-order
   │   body: { amount, currency, coupon?, customer, utm }
   │
   ▼
create-order route
   │
   │ Packs 15 fields into Razorpay order notes:
   │   first_name, last_name, customer_email, customer_phone,
   │   country_code, city, utm_source, utm_medium, utm_campaign,
   │   utm_content, utm_term, fbclid, gclid, landing_url, referrer
   │ Returns order_id
   │
   ▼
Razorpay checkout.js modal opens → user pays
   │
   │ On success, Razorpay calls handler(response)
   │ handler does (synchronously, in order):
   │   1. void setMetaAdvancedMatching(customer)        — fire-and-forget
   │   2. fetch('/api/razorpay/verify-payment', {
   │        keepalive: true, body: { orderId, paymentId, signature, customer, utm, fbc, fbp, eventSourceUrl }
   │      })                                            — keepalive, NO await
   │   3. sessionStorage writes for thank-you page
   │   4. router.push('/book-a-call?...')               — immediate redirect
   │
   ▼
Two paths now run in parallel (server-side):

  PATH A: /api/razorpay/verify-payment (started by browser, T+0.1s)
  ────────────────────────────────────
  1. Validate body, verify Razorpay HMAC signature → 400 if invalid
  2. Layer 1 dedup: claimEventId(paymentId) → skip if already claimed in same Lambda
  3. Gate: production host + amount > ₹1, else skip silently
  4. Layer 2 dedup: getPaymentDedupState(paymentId)
       → { pabblyFired, capiFired, existingNotes }
  5. Decide what to fire:
       willFirePabbly = !pabblyFired
       willFireCapi   = !capiFired
  6. await Promise.allSettled([
       firePabblyWebhook(...),       — full 25-field payload
       fireMetaCapi(['Purchase','sales'], ...)
     ])
  7. markFires(paymentId, existingNotes, { pabblySucceeded, capiSucceeded })
       → writes only the markers that returned 2xx in this run
  8. Respond 200 to browser (browser already moved on)

  PATH B: /api/razorpay/webhook (Razorpay server-to-server, T+5–30s)
  ─────────────────────────────────────
  1. Verify x-razorpay-signature HMAC → 400 if invalid
  2. Bail if event !== "payment.captured"
  3. Layer 1 dedup: claimEventId(paymentId)
  4. Parallel fetch: orders.fetch(orderId) + getPaymentDedupState(paymentId)
       → orderNotes for customer+utm, dedupState for markers
  5. If BOTH markers already set → full skip
  6. Build customer + utm from order notes (same shape as Layer A's payload)
  7. Gate: production host + amount > ₹1
  8. Decide what to fire (based on which markers are unset)
  9. await Promise.allSettled([ firePabblyWebhook, fireMetaCapi ])
  10. markFires for whichever succeeded
  11. Respond 200 to Razorpay
```

Typical outcome: PATH A fires both successfully, marks both. PATH B arrives, sees both marked, full skip. **One Pabbly row, one Purchase event, one sales event per paid lead. Zero duplicates, zero misses.**

---

## Part 4 — The exact Pabbly payload (25 fields)

Built by `lib/pabbly.ts` `firePabblyWebhook()`. Identical regardless of which route fires (PATH A or PATH B).

| Field | Type | Source | Example |
|---|---|---|---|
| `first_name` | string | form → request body (PATH A) or order notes (PATH B) | "Manav" |
| `last_name` | string | same | "Lohia" |
| `full_name` | string | pre-joined `${first_name} ${last_name}` | "Manav Lohia" |
| `email` | string | form | "user@example.com" |
| `phone` | string | dial code + form number | "+919876543210" |
| `city` | string | form | "Mumbai" |
| `state` | string | form (empty unless collected) | "" |
| `zip_code` | string | form (empty unless collected) | "" |
| `country_code` | string | form country picker | "IN" |
| `payment_id` | string | Razorpay payment_id | "pay_SsoxXXX" |
| `order_id` | string | Razorpay order_id | "order_SsoxYYY" |
| `amount` | string | clientConfig.pricing.price (string) | "97" |
| `currency` | string | "INR" | "INR" |
| `coupon` | string | applied coupon code | "" |
| `payment_date` | string | YYYY-MM-DD (IST) | "2026-05-23" |
| `payment_time` | string | HH:MM:SS (IST, 24h) | "23:40:26" |
| `payment_timestamp` | string | ISO 8601 UTC | "2026-05-23T18:10:26.123Z" |
| `utm_source` | string | URL / sessionStorage | "ig" |
| `utm_medium` | string | same | "paid_social" |
| `utm_campaign` | string | same | "Creators_17_02" |
| `utm_content` | string | same | "Test_Ad_8" |
| `utm_term` | string | same | "audience_X" |
| `gclid` | string | Google click id | "" |
| `fbclid` | string | Facebook click id | "IwY2x..." |
| `referrer` | string | document.referrer at landing | "" |
| `landing_url` | string | first URL the visitor landed on | "https://teamfitarjun.com/?utm_source=ig" |

**Key invariant:** every field exists in every fire (with "" if unknown). Pabbly column mappings should reference these exact keys. **The webhook fallback path produces the same shape** by reading from Razorpay order notes that create-order seeded — that's why we put all the UTMs there too, not just first_name/email/phone.

---

## Part 5 — Razorpay order notes (the create-order seed)

Razorpay's documented limit is **15 keys per `notes` object, 256 chars per value**. We use all 15 — the first slot is the funnel-ownership marker (Part 17), the rest carry payload data INCLUDING `fbp` for Meta CAPI EMQ (Part 18):

```
funnel  ← cross-business pollution guardrail (clientConfig.funnel.slug)
first_name, last_name, customer_email, customer_phone, country_code, city,
utm_source, utm_medium, utm_campaign, utm_content, utm_term,
fbclid, fbp, landing_url
```

Set in `/api/razorpay/create-order` at order creation time. Read in `/api/razorpay/webhook` via `razorpay.orders.fetch(orderId)` (with one retry on transient errors) to rebuild the full Pabbly payload, verify funnel ownership, AND recover Meta's `fbc` + `fbp` for the CAPI fire.

This is the **only** way to ensure the webhook fallback fires with identical data to verify-payment — because UTMs, fbclid, and fbp only exist in the browser's sessionStorage/cookies, not in Razorpay's webhook payload.

**Two fields had to be dropped to fit `funnel` + `fbp` into the 15-key limit:**
- `referrer` (least load-bearing — ad traffic carries `fbclid` + `utm_source`; `landing_url` overlaps; most direct visits have empty referrer anyway)
- `gclid` (only useful for Google Ads CAPI which this Meta-driven funnel doesn't fire)

The verify-payment primary path still ships BOTH `referrer` and `gclid` from browser sessionStorage; only the rare webhook-fallback path omits them, and only for the purposes of Pabbly attribution (Meta CAPI doesn't use either).

---

## Part 6 — Razorpay payment notes (the dedup state)

Two independent markers, written by `lib/payment-dedup.ts` `markFires()`:

| Field | When set | Read by |
|---|---|---|
| `pabbly_fired` | After `firePabblyWebhook()` returned 2xx | Both routes, before deciding to re-fire Pabbly |
| `capi_fired` | After `fireMetaCapi()` returned 2xx | Both routes, before deciding to re-fire CAPI |

Each value is a millisecond UTC timestamp (e.g. `"1716490841329"`). Visible in Razorpay Dashboard → Orders → click any order → Payments tab → click payment → Notes section. Useful for ops verification: a captured payment without these markers means our code didn't fire (run the backfill script).

**Why two markers, not one combined "fired"?** Pabbly and Meta have independent failure modes. A single marker would mean: if Pabbly was down for 5 minutes but Meta succeeded, the fallback would retry both, hitting Meta twice (Meta would dedupe, but we'd waste API calls and pollute Vercel logs). Two markers let the fallback retry only what failed.

---

## Part 7 — The exact Meta CAPI payload

Built by `lib/capi.ts` `fireMetaCapi()`. Both `Purchase` and `sales` ride in a single HTTPS POST to `graph.facebook.com/v25.0/{PIXEL_ID}/events`, sharing all fields except `event_name`.

```json
{
  "data": [
    {
      "event_name": "Purchase",
      "event_time": 1716490841,
      "event_id": "pay_SsoxXXX",
      "event_source_url": "https://teamfitarjun.com/checkout?utm_source=ig",
      "action_source": "website",
      "user_data": {
        "em": ["<sha256(lowercase trimmed email)>"],
        "ph": ["<sha256(digits-only phone)>"],
        "fn": ["<sha256(lowercase first_name)>"],
        "ln": ["<sha256(lowercase last_name)>"],
        "ct": ["<sha256(lowercase city, a-z only)>"],
        "country": ["<sha256(lowercase ISO-2)>"],
        "external_id": ["<sha256(normalised email)>"],  // same hash as em
        "fbc": "<raw _fbc cookie>",
        "fbp": "<raw _fbp cookie>",
        "client_ip_address": "<raw IP>",
        "client_user_agent": "<raw UA>"
      },
      "custom_data": {
        "currency": "INR",
        "value": 97,
        "payment_id": "pay_SsoxXXX"
      }
    },
    {
      "event_name": "sales",
      // identical to above except for event_name
    }
  ],
  "test_event_code": "TESTXXXX"  // ONLY in non-prod
}
```

**11 matching signals when fully populated → EMQ 9.5+.**

`external_id = sha256(normalised email)`. This is intentional: the browser's MAM cookie carries the same value, so Meta's external_id consistency check passes across browser PageView + server Purchase/sales events.

`event_id = Razorpay payment_id`. The same value is used for BOTH events. Meta dedupes on `(event_name, event_id)`, so retries from the fallback path never double-count.

`event_source_url` priority: `window.location.href` from client → request `referer` header → fallback to `https://{brand.domain}/checkout`.

`value` is in **major units** (rupees, not paise). Always.

---

## Part 8 — The browser Pixel layer

**Exactly one event fires from the browser: `PageView`.** No `Purchase`, `InitiateCheckout`, `Lead`, `ViewContent`. Conversion events are server-only via CAPI.

Fired from two sites, coordinated by a `window.__arjun_last_pv` token to prevent double-fires:

1. **Inline script in `app/layout.tsx`** — runs `afterInteractive` on every full page load. Initialises `fbq`, reads `arjun_mam` cookie, re-inits with hashed identity, then fires PageView. Sets `window.__arjun_last_pv = { pathname, at: Date.now() }`.

2. **`components/PixelPageView.tsx`** — a client component mounted in the root layout. `useEffect` keyed on `usePathname()`. On initial mount, `firstRender` ref skips (the inline script handled it). On every subsequent navigation, re-applies MAM and fires PageView — *unless* the token shows a fire of the same pathname less than 1 second ago, in which case it suppresses and logs `[pixel] suppressed duplicate PageView`.

Why both? The inline script only runs on hard page loads. Next.js App Router preserves layout on SPA navigations and does NOT re-execute `<Script>` tags. Without `PixelPageView`, only the landing page would ship a PageView — Landing → Checkout → Book-a-call → Thank-you would silently get zero additional events.

### Manual Advanced Matching (MAM) cookie

`arjun_mam` first-party cookie, 30-day TTL, `SameSite=Lax`. Written by `lib/analytics.ts` `setMetaAdvancedMatching()` once the checkout form is valid + filled (500ms debounce). Contains hashed `em, ph, fn, ln, ct, country, external_id` (7 fields, SHA-256 hex).

Read by the inline pixel script on every page load (so a cold returning visitor's PageView still ships with full hashed identity, raising EMQ for the PageView event to ~8.5).

`external_id` derived as `sha256(normalised email)` — identical to the CAPI side. Meta requires consistency across channels.

---

## Part 9 — Tracking gates (block test traffic from reaching production)

`lib/tracking-gate.ts` exposes:

```ts
isProductionClient(): boolean       // hostname check on browser
isProductionServer(request): boolean // host header check on server
isPaidAmount(rupees): boolean        // value > 1
```

| Surface | Gate applied |
|---|---|
| Inline pixel script in layout | hostname (Vercel preview / localhost = no fbq init at all) |
| `setMetaAdvancedMatching()` | hostname (no cookie write off prod) |
| `PixelPageView` route-change fire | hostname |
| verify-payment route (Pabbly + CAPI fires) | hostname + amount > ₹1 |
| webhook route (Pabbly + CAPI fires) | hostname + amount > ₹1 |
| /api/quiz route (Pabbly forward) | hostname |
| /api/payment-issue route (Pabbly forward) | hostname |

This means you can safely deploy to `arjun-*.vercel.app` and test with a ₹1 Razorpay charge — zero events fire to Meta, zero rows hit Pabbly. Real events only flow when:
1. Hostname is the production domain (`teamfitarjun.com` or a subdomain)
2. AND amount > ₹1 (for server-side fires)

---

## Part 10 — Vercel logs to expect

### Healthy primary path (verify-payment fires both, webhook becomes no-op)

```
[verify-payment] received POST for paymentId=pay_X orderId=order_Y email=u@e.com
[verify-payment] event_id=pay_X value=97 email=u@e.com — firing { pabbly:true, capi:true }
[capi] OK event_id=pay_X events=[Purchase, sales]
[pabbly] OK order=order_Y payment=pay_X payload={"first_name":"Manav",…25 fields…}
[dedup] marked payment pay_X: pabbly_fired=1716490841329 capi_fired=1716490841329

# ~5–30s later
[webhook] received payment.captured for paymentId=pay_X orderId=order_Y
[dedup] payment pay_X state: pabbly_fired=1716490841329 capi_fired=1716490841329
[webhook] payment pay_X already has BOTH fires marked done — full skip
```

### Webhook-only path (browser died, fallback caught it)

```
# (no verify-payment log for this paymentId)
[webhook] received payment.captured for paymentId=pay_X orderId=order_Y
[webhook] event_id=pay_X value=97 email=u@e.com — firing { pabbly:true, capi:true }
[capi] OK event_id=pay_X events=[Purchase, sales]
[pabbly] OK order=order_Y payment=pay_X payload={…full 25 fields…}
[dedup] marked payment pay_X: pabbly_fired=… capi_fired=…
[webhook] complete for event_id=pay_X — pabblySucceeded=true capiSucceeded=true
```

### Partial retry (Pabbly was down during primary; webhook retries just Pabbly)

```
[verify-payment] event_id=pay_X … firing { pabbly:true, capi:true }
[capi] OK event_id=pay_X events=[Purchase, sales]
[pabbly] webhook returned 502 …
[dedup] marked payment pay_X: capi_fired=…   ← only CAPI marker set
[verify-payment] Pabbly fire did NOT succeed for pay_X — leaving pabbly_fired UNSET

# webhook arrives
[webhook] received payment.captured for paymentId=pay_X
[dedup] payment pay_X state: capi_fired=…    ← capi already done
[webhook] event_id=pay_X … firing { pabbly:true, capi:false }   ← just Pabbly
[pabbly] OK …
[dedup] marked payment pay_X: pabbly_fired=…
```

### Bad signal (action required)

| Log line | Meaning | Fix |
|---|---|---|
| `[webhook] invalid signature` | `RAZORPAY_WEBHOOK_SECRET` in Vercel ≠ Razorpay Dashboard | Re-paste the secret in Razorpay Dashboard → Webhooks → your webhook |
| `[webhook] orders.fetch(...) failed twice` | Razorpay API auth or network issue | Verify `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` in Vercel |
| `[webhook] order ... notes missing identity fields` | create-order didn't seed notes | Check that browser sent `customer + utm` to create-order |
| `[pabbly] webhook returned 4xx/5xx` | Pabbly URL wrong or workflow errored | Full payload logged on same line — re-send via backfill script |
| `[pixel] suppressed duplicate PageView` | Dedup token caught a same-pathname double-fire <1s apart | Investigate the source (likely safe to ignore) |

### How to find a specific lead

Vercel → Logs → Search by:
- `pay_SsoxXXX` (payment_id)
- `user@example.com` (email)
- `[pabbly] OK` (every successful Pabbly fire)
- `[webhook] received` (every incoming webhook attempt)
- `[verify-payment] received` (every incoming verify-payment attempt)

If you can't find `[pabbly] OK ... payment=pay_X` for a specific payment, run the backfill script.

---

## Part 11 — Failure modes and recovery

| Failure | Effect | Recovery |
|---|---|---|
| Mobile tab killed before keepalive flushes | verify-payment never reaches server | Webhook fires 5-30s later with full data from order notes |
| Browser handler throws synchronously | verify-payment fetch never sent | Same — webhook covers |
| Pabbly down for <30s | verify-payment Pabbly fire fails | `pabbly_fired` marker NOT set → webhook retries just Pabbly |
| Pabbly down for >30s | Both verify-payment AND webhook Pabbly fires fail | Run `node scripts/backfill-pabbly.mjs YYYY-MM-DD YYYY-MM-DD --send` next day |
| Razorpay API down (orders.fetch fails in webhook) | Webhook can't read notes → partial Pabbly payload | Backfill script retries with full data once Razorpay is back |
| `payments.edit` fails (can't write marker) | Next fallback path may re-fire | Pabbly may receive duplicate; Meta still dedupes via event_id |
| Pabbly URL changed without redeploy | All Pabbly fires fail | Update `PABBLY_WEBHOOK_URL` in Vercel env, redeploy, backfill |
| Razorpay webhook secret rotated without updating Vercel | All webhook attempts return 400 | Update `RAZORPAY_WEBHOOK_SECRET` in Vercel env, redeploy |

The backfill script (`scripts/backfill-pabbly.mjs`) is the safety net for ANY combination of the above. It pulls captured payments from Razorpay API and replays into Pabbly. Dry-run by default, `--send` to fire, `--skip pay_X,pay_Y` to exclude already-reconciled payments.

---

## Part 12 — Common pitfalls (do NOT do these)

| Anti-pattern | Why it breaks things |
|---|---|
| `void firePabblyWebhook(...)` in a Vercel route | Lambda terminates after response, killing the in-flight POST. SILENT drops. |
| `await fetch('/api/verify-payment', {...})` in browser handler | Mobile tabs close before await resolves. Always use `keepalive: true` and don't await. |
| `claimEventId()` as your ONLY dedup | In-memory Map; invisible to other Lambda instances. Add persistent layer (Razorpay payment notes). |
| Single combined `fired` marker for Pabbly + CAPI | Conflates two independent failure modes. Use two markers. |
| Mark "fired" BEFORE the actual fire returns 2xx | If Pabbly returns 5xx, the marker is set anyway → no retry possible. Mark only on success. |
| Firing browser `Purchase` from /thank-you | Double-counts in Events Manager. Conversion is server-only. |
| Razorpay `notes` with only customer fields (no UTMs) | Webhook fallback can't rebuild attribution. Pack all 15 fields. |
| Webhook with no funnel-source check on a shared Razorpay account | Razorpay sends `payment.captured` to ALL account-level webhook URLs — including ours — for **every** business that shares the account (WooCommerce, other coaching funnels, etc.). Without filtering, the webhook fires Pabbly + CAPI for unrelated business payments. ALWAYS check `order.notes.funnel === clientConfig.funnel.slug` early in the webhook handler. See Part 17. |
| Reading `payment.notes` from the webhook payload directly | Webhook payload is frozen at Razorpay's queue time — won't include our `pabbly_fired` edit. Always `payments.fetch()` for current state. |
| Pixel ID hardcoded in code | Use `NEXT_PUBLIC_META_PIXEL_ID` env var so swap is one-line. |
| `META_CAPI_ACCESS_TOKEN` with `NEXT_PUBLIC_` prefix | Server-only secret. Prefix leaks it to the browser bundle. |
| Allowing Vercel preview URLs to fire events to production pixel/CRM | Pollutes Events Manager + Pabbly with test traffic. Use hostname gate + amount-gate. |
| Test events without clearing `META_CAPI_TEST_EVENT_CODE` before going live | Meta excludes test-coded events from real reporting. Production = blank. |
| Trusting Razorpay webhook to fire on `payment.authorized` | Only `payment.captured` means money has actually moved. Filter all other events out. |
| Subscribing webhook to multiple event types | Each event = a separate POST. Subscribe ONLY to `payment.captured` to cut noise. |

---

## Part 13 — File-by-file map (this codebase)

| File | Role |
|---|---|
| `app/api/razorpay/create-order/route.ts` | Creates Razorpay order with 15-field notes (identity + UTM + landing) |
| `app/api/razorpay/verify-payment/route.ts` | PATH A. Awaits Pabbly + CAPI. Layer 1 + Layer 2 dedup. Marks fires. |
| `app/api/razorpay/webhook/route.ts` | PATH B. Same flow as A, with parallel order-notes + payment-dedup-state fetch. |
| `app/api/quiz/route.ts` | Forwards post-purchase quiz answers to Pabbly. Production-host gate only. |
| `app/api/payment-issue/route.ts` | Forwards payment-failure reports to Pabbly. Host gate only. |
| `lib/pabbly.ts` | `firePabblyWebhook()` — returns `Promise<boolean>` (true on 2xx). Builds 25-field payload. Logs full payload on success. |
| `lib/capi.ts` | `fireMetaCapi()` — v25.0 endpoint, accepts event-name array, ships dual events in one POST. Returns `Promise<boolean>`. |
| `lib/dedup.ts` | In-process `claimEventId()` (Layer 1). Honest comment about per-instance limitation. |
| `lib/payment-dedup.ts` | Persistent dedup via Razorpay payment notes (Layer 2). `getPaymentDedupState`, `markFires`. |
| `lib/tracking-gate.ts` | Production-host + paid-amount gates. Single source of truth. |
| `lib/analytics.ts` | Client MAM module. `setMetaAdvancedMatching`, `reapplyMamFromCookie`. Writes `arjun_mam` cookie. |
| `lib/hash.ts` | SHA-256 + Meta-spec normalisations. |
| `lib/request.ts` | Extract IP / UA / referer from `Request`. |
| `app/layout.tsx` | Root layout. Inline pixel script with hostname gate, MAM cookie read, PageView fire + `__arjun_last_pv` token write. |
| `components/PixelPageView.tsx` | SPA route-change PageView. Token check, hostname check, MAM reapply. |
| `app/checkout/CheckoutView.tsx` | Form, Razorpay modal, keepalive fire-and-redirect handler, MAM form-fill `useEffect`. |
| `scripts/backfill-pabbly.mjs` | Recovery script. Pure ESM, no extra deps. Dry-run by default. |

---

## Part 14 — Env vars (single source of truth)

```
NEXT_PUBLIC_PRICE                  # display price + amount gate threshold
NEXT_PUBLIC_META_PIXEL_ID          # browser + server (CAPI) read same var
META_CAPI_ACCESS_TOKEN             # SERVER ONLY. Never NEXT_PUBLIC_.
META_CAPI_TEST_EVENT_CODE          # blank in prod; set ONLY during Test Events validation
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET                # server only
RAZORPAY_WEBHOOK_SECRET            # server only, MUST match Razorpay Dashboard value
PABBLY_WEBHOOK_URL                 # purchase webhook
PABBLY_QUIZ_WEBHOOK_URL            # optional; falls back to PABBLY_WEBHOOK_URL
NEXT_PUBLIC_GA_MEASUREMENT_ID      # optional
```

**Vercel-specific:** these MUST be set in Vercel → Project Settings → Environment Variables → Production. Updating `.env.local` does NOT affect Vercel. After updating, redeploy.

---

## Part 15 — Migration / upgrade guide (for a sibling funnel)

You almost certainly already have:
- A working `create-order` route
- A working `verify-payment` route with signature verification
- A Pabbly fire after successful payment
- Maybe a Meta CAPI fire
- Possibly a Razorpay webhook

The upgrade is to layer the **reliability + dedup architecture** on top, without rewriting your working business logic.

### Audit checklist (run BEFORE touching code)

1. **Does verify-payment use `void firePabbly(...)` or `await firePabbly(...)`?**
   If `void` → losing conversions to Vercel Lambda kill. Convert to `await`.

2. **Does the browser handler await the verify-payment fetch before `router.push`?**
   If yes → losing mobile conversions to tab kill. Switch to `fetch(..., { keepalive: true })` + immediate redirect (no await).

3. **Does any dedup logic span verify-payment AND webhook?**
   If using in-memory `Map` or `Set` only → broken across Lambda instances. Add persistent dedup (Razorpay payment notes are the simplest store).

4. **What does Razorpay `notes` contain at order creation?**
   If only customer fields (or empty) → webhook fallback will produce sparse Pabbly rows. Pack all 15 fields: customer + UTMs + landing_url.

5. **Does the webhook read order notes for customer + UTM data?**
   If it uses only `payment.email` / `payment.contact` → sparse data. Switch to `orders.fetch(orderId).notes`.

6. **Is there a webhook signature check?**
   Mandatory. Without it, anyone can spoof Pabbly + CAPI fires.

7. **Are there hostname / amount gates?**
   If preview deploys + test transactions fire to production tracking → pollutes Events Manager and CRM. Add gates.

8. **Does the browser fire only PageView, or also `Purchase`/`InitiateCheckout`?**
   Browser-side `Purchase` doubles your conversion count in Events Manager unless deduped explicitly. Default: server-only conversions, browser only fires PageView.

9. **Does the inline Pixel script also fire PageView on SPA route changes?**
   `<Script>` doesn't re-execute on `router.push`. Need a `usePathname()` + `useEffect` component to fire on subsequent navigations.

10. **Is there a backfill / reconciliation tool?**
    For the once-in-a-blue-moon failure case. Pure ESM script using Razorpay SDK is enough.

11. **Is the Razorpay account shared with ANY other business / funnel / WooCommerce site?**
    If yes — and this is more common than people realise, especially for agencies + multi-brand operators — the webhook MUST filter by a funnel-source marker on `order.notes` (see Part 17). Without it, the webhook will fire Pabbly + CAPI for every unrelated payment captured on the same Razorpay account. Symptom: phantom Pabbly rows with garbage amounts (₹40,000, ₹2,500, etc.) and inflated Meta Purchase counts that don't match the funnel's actual revenue. Add the `funnel` field to `notes`, drop a low-value field (we dropped `referrer`) to stay within Razorpay's 15-key limit, and check `notes.funnel === expectedSlug` before any fire in the webhook AND in the backfill script.

### Order of upgrades (small, atomic, each ship-able)

1. **Add `await` + `Promise.allSettled` to verify-payment Pabbly + CAPI fires.** Highest-impact single change. Eliminates 30-70% of silent drops immediately.

2. **Switch browser handler to `keepalive: true` fire-and-redirect.** Don't await before `router.push`.

3. **Pack 15-field notes in create-order.** Webhook fallback becomes useful for the first time.

4. **Add persistent dedup (Razorpay payment notes with two separate markers).** Add a `lib/payment-dedup.ts`-equivalent. Read in both routes before firing; mark each on success.

5. **Add hostname + amount gates.** Test on Vercel preview safely.

6. **Add the SPA PageView component.** Use `usePathname()` + `useEffect`.

7. **Add the same-pathname token guard** for PageView dedup.

8. **Add the backfill script.** Run after first real production traffic to catch any gaps.

9. **Add the funnel-source filter** (see Part 17). Mandatory if the Razorpay account ever processes payments for anything other than this single funnel.

### Don't blindly copy this codebase

This funnel has project-specific names (`arjun_mam` cookie, `[verify-payment]` log prefixes, `clientConfig.brand.domain`). When porting:
- Rename the MAM cookie to something project-scoped
- Keep your existing route filenames and brand config — don't restructure
- Adapt the Pabbly payload shape to YOUR Pabbly workflow's column mappings (the FIELD NAMES might differ — check the receiving workflow)
- Your Meta pixel ID + CAPI access token are different
- Your Razorpay account, key IDs, webhook secret are different
- Don't import this codebase's `clientConfig` or env keys verbatim

The architecture (the dedup model, the await pattern, the data flow) is portable. The specific code is not.

---

## Part 16 — TL;DR cheatsheet

- Fire from BOTH `/api/verify-payment` AND `/api/webhook`, dedup'd. Each AWAITS the Pabbly + CAPI calls before responding.
- Browser uses `fetch(..., { keepalive: true })` and doesn't await before redirect.
- Pack 15 fields into Razorpay order `notes` at create-order time. **First slot is the `funnel` marker** (Part 17). The webhook fallback rebuilds full payload from there.
- Webhook MUST check `order.notes.funnel === clientConfig.funnel.slug` BEFORE any dedup work, fires, or marker writes.
- Dedup with TWO separate markers on Razorpay payment notes: `pabbly_fired`, `capi_fired`. Mark each only after its fire returned 2xx.
- Browser fires ONLY `PageView`. No `Purchase` or `InitiateCheckout` from the client.
- Server CAPI fires `Purchase` + `sales` (dual event, single POST). `event_id = payment_id`.
- Gate all event firing by hostname + amount > ₹1.
- Have a backfill script ready for the bad-day-at-Pabbly recovery case. The backfill script applies the same funnel-source filter.

**End state:** every paid lead lands in Pabbly exactly once with all 25 fields, every paid lead lands in Meta as exactly one Purchase + one sales event with 11 matching signals, browser PageView fires exactly once per real page view, and unrelated payments from other businesses sharing the same Razorpay account never touch our Pabbly + CAPI pipelines. Zero misses, zero duplicates, zero pollution, regardless of mobile tab kill or Vercel Lambda quirks.

---

## Part 17 — Multi-funnel Razorpay accounts: the cross-pollution guardrail

### The problem this solves

Razorpay webhook subscriptions are configured at the **account level**, not per-product or per-website. A single Razorpay account can have multiple webhook URLs registered (one per integration), and **every** `payment.captured` event on the account fires **every** webhook URL — regardless of which integration created the order.

In real-world setups this is the norm, not the edge case: agencies running multiple client funnels on one account, multi-brand operators (e.g. an Indian fitness coach + their personal training app + their WooCommerce supplement store all on the same Razorpay), product teams testing in production. The author of this funnel observed it the hard way: a customer paid **₹40,000** to a sibling WooCommerce site sharing the same Razorpay account, the webhook event hit `teamfitarjun.com/api/razorpay/webhook`, our route ran the same flow it always does, and Pabbly received a phantom row for someone who never visited the funnel. Meta CAPI fired a ₹40,000 Purchase event too, inflating the conversion count + value.

This affects:
- **Pabbly:** phantom rows polluting the CRM, breaking row counts, triggering downstream emails to people who never opted in
- **Meta CAPI:** inflated Purchase counts that don't reconcile against Razorpay revenue for THIS funnel, EMQ tanking on low-quality phantom events
- **Razorpay payment notes:** our `pabbly_fired` / `capi_fired` markers written onto someone else's payment (harmless but noisy)
- **Vercel logs:** noise that masks real issues

### The fix in one sentence

Stamp every order WE create with a unique funnel identifier in `notes`. The webhook reads it back and aborts early if it doesn't match.

### Implementation (this codebase)

**`app/api/razorpay/create-order/route.ts`** — the order-creation notes object's FIRST key is the funnel identifier:

```ts
const notes: Record<string, string> = {
  funnel: clientConfig.funnel.slug,    // ← cross-business guardrail
  first_name: ...,
  last_name: ...,
  // ... 13 more payload fields ...
  landing_url: ...,
};
```

`clientConfig.funnel.slug` for this project is `"arjun-blueprint"`. For a sibling funnel, use a slug that's unique across all integrations on the same Razorpay account.

**`app/api/razorpay/webhook/route.ts`** — after fetching order notes, but BEFORE claiming the eventId or running any dedup / gate / fire logic:

```ts
const orderNotes = await fetchOrderNotesWithRetry(orderId);
const expectedFunnel = clientConfig.funnel.slug;

if (orderNotes.funnel !== expectedFunnel) {
  console.log(
    `[webhook] ignoring payment ${paymentId} — order ${orderId} is NOT from our funnel ` +
      `(notes.funnel=${orderNotes.funnel ?? "<unset>"}, expected=${expectedFunnel})`,
  );
  return NextResponse.json({ ok: true, ignored: "not_our_funnel" });
}

// ... only NOW do we claim eventId, check dedup markers, fire Pabbly + CAPI ...
```

Returns 200 (not 4xx) so Razorpay marks the webhook as delivered and doesn't retry for 24h. The log line is easy to grep — `[webhook] ignoring payment` — so you can confirm cross-business traffic is being correctly filtered.

**`scripts/backfill-pabbly.mjs`** — same filter applied to every captured payment the script pulls from Razorpay's payments API. Skipped payments are counted separately:

```
Done. OK=12  FAIL=0  SKIPPED-NOT-OURS=47  OUR-FUNNEL=12
```

The script hardcodes the `FUNNEL_SLUG` constant at the top — keep it in sync with `clientConfig.funnel.slug`.

### Why early-exit (before dedup/claim)

If the funnel check ran AFTER `claimEventId(paymentId)`, every cross-business payment would pollute our in-memory dedup Map and consume one Razorpay `payments.fetch` call (the dedup-state lookup) for no reason. By exiting BEFORE those steps, an unrelated payment costs us exactly **one Razorpay API call** (the order-notes fetch we'd have made anyway) and nothing else.

### Why NOT just check the amount

A naive alternative is `if (payment.amount !== clientConfig.pricing.paise) skip`. Three reasons not to do this:

1. **Fragile to price changes.** Update `NEXT_PUBLIC_PRICE` from 97 to 197 → every in-flight ₹97 payment captured after the change but before the deploy is silently rejected.
2. **False positives.** Another business on the same account might charge the same amount, would still be processed.
3. **No defense if the unrelated business also charges 97.** Symptom: phantom Pabbly row that LOOKS like a real one.

The notes-marker approach is robust to all three.

### Why NOT use `order.receipt`

`receipt` is freely settable by any integration on the account. Other systems can and do use receipts like `rcpt_…` or `order_…`. Using receipt as the discriminator would catch most cases but leak the rare ones. The notes-marker is uniquely scoped to OUR code.

### Migration concern — orders created BEFORE this deploy

Orders created BEFORE this guardrail rolled out don't have `notes.funnel` set. If any of them later trigger a webhook (e.g. captured today but order was created last week before deploy), the webhook will treat them as not-our-funnel and skip.

In practice this affects ~zero leads because:
- `create-order` and `verify-payment` happen seconds apart
- Orders that haven't been paid yet won't trigger webhook deliveries
- Orders already paid have already been processed by either path

No backfill of historical orders needed. If you DO want to retroactively process pre-deploy paid orders, run the backfill script with the old `FUNNEL_SLUG` value set to `"<unset>"` temporarily — but this defeats the guardrail and risks the same cross-business pollution, so prefer manual reconciliation if it ever matters.

### How to verify the guardrail is working

1. **Make one real ₹97 test purchase on `teamfitarjun.com`.** Vercel logs should show:
   ```
   [verify-payment] received POST for paymentId=pay_X …
   [pabbly] OK …
   [webhook] received payment.captured for paymentId=pay_X …
   [webhook] payment pay_X already has BOTH fires marked by verify-payment — full skip
   ```
   (or the webhook-only path if the browser died — either is fine, both result in exactly one Pabbly row.)

2. **Have someone make a payment to one of your OTHER Razorpay-account businesses** (or trigger one yourself). Within ~30s, Vercel logs should show:
   ```
   [webhook] received payment.captured for paymentId=pay_Y orderId=order_Z
   [webhook] ignoring payment pay_Y — order order_Z is NOT from our funnel (notes.funnel=<unset>, expected=arjun-blueprint)
   ```
   And **zero** `[pabbly] OK` or `[capi] OK` lines for `pay_Y`. **Zero Pabbly task** for that payment. **Zero Meta CAPI** event for that payment.

3. **Run the backfill script in dry-run mode for a date range that includes cross-business payments.** Output should clearly distinguish:
   ```
   SKIP-NOT-OURS pay_Y  notes.funnel=<unset>  email=…  amount=40000
   [DRY-RUN] pay_X  (test.lead@…): { …our funnel payload… }
   Done (dry run). 1 OUR-FUNNEL payments would have been sent, 6 skipped as not-ours.
   ```

If any of these checks fail, the filter is broken and unrelated payments are leaking into the funnel's data.

### When you do NOT need this guardrail

The only case where you can safely skip it: the Razorpay account is **dedicated** to this single funnel, with no other websites, products, or integrations sharing it. If you're 100% sure of this AND will remain so forever, the guardrail is unnecessary. In every other case (which is most cases), it's mandatory.

---

## Part 18 — Webhook-path EMQ: recovering `fbc` + `fbp` from order notes

### The problem this solves

Meta CAPI's Event Match Quality scoring weights `fbc` (Facebook click ID, raw) and `fbp` (Facebook browser ID, raw) heavily — Meta's own Events Manager diagnostic credits **~16% EMQ boost for `fbc`** and **~13% for `fbp`** when present on every Purchase event.

Both are browser cookies:
- `_fbc` is set by `fbevents.js` from the `?fbclid=` URL parameter (or by us synthesising it via `fb.1.{ms}.{fbclid}`)
- `_fbp` is a random per-browser ID set by `fbevents.js` on first PageView

The verify-payment path (browser-initiated) reads both cookies and passes them in the request body, so its CAPI fire ships both. **The webhook path (Razorpay server-to-server) does NOT** — Razorpay's webhook payload doesn't carry browser cookies. Without recovery, every webhook-fallback CAPI fire loses ~29% EMQ relative to the verify-payment path.

Observed symptom: EMQ on the `Purchase` event drops from ~9.5 (all verify-payment fires) toward ~7.9 as the webhook-fallback proportion grows. Meta Events Manager → Diagnostics shows "Click ID (fbc)" and "Browser ID (fbp)" listed under "Other parameters" with `~16% increase` and `~13% increase` potential outcomes.

### The fix — pack into notes, recover on the webhook

**`fbp` is stored in the Razorpay order `notes`** at create-order time. CheckoutView reads `_fbp` from the browser via `readCookie('_fbp')` and sends it in the create-order request body. The server packs it into notes alongside the other 14 fields (we dropped `gclid` to make room — see Part 5).

**`fbc` is NOT stored.** It's reconstructed from `notes.fbclid` on demand using `buildFbcFromFbclid()` in [lib/utm.ts](lib/utm.ts), which generates Meta's documented format `fb.1.{unix_ms}.{fbclid}`. This is exactly what `fbevents.js` would have written to the browser `_fbc` cookie if the click had come from a Facebook ad. (If the user didn't come from a Facebook ad, `notes.fbclid` is empty and `buildFbcFromFbclid` returns `undefined` — no fbc shipped, same as a real direct visit.)

### Implementation (this codebase)

**`app/checkout/CheckoutView.tsx`** — send fbp to create-order:

```ts
const orderRes = await fetch("/api/razorpay/create-order", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    amount, currency, coupon, customer, utm,
    fbp: readCookie("_fbp"),   // ← NEW
  }),
});
```

**`app/api/razorpay/create-order/route.ts`** — pack fbp into notes:

```ts
const notes: Record<string, string> = {
  funnel: clientConfig.funnel.slug,
  // ... 12 other fields ...
  fbclid: clamp(utm.fbclid),
  fbp: clamp(body.fbp),        // ← NEW (replaced gclid)
  landing_url: clamp(utm.landing_url),
};
```

**`app/api/razorpay/webhook/route.ts`** — recover fbc + fbp, pass to CAPI:

```ts
import { buildFbcFromFbclid } from "@/lib/utm";

// ... after fetching orderNotes ...

const fbp = orderNotes.fbp ?? "";
const fbc = buildFbcFromFbclid(orderNotes.fbclid) ?? "";

await fireMetaCapi({
  // ... other args ...
  fbc: fbc || undefined,
  fbp: fbp || undefined,
});
```

### Why we don't also store `fbc` separately

It would waste a notes slot. `fbc` is purely a transformation of `fbclid` — same information content, different format. Razorpay already stores `fbclid`; recomputing `fbc` is one line of code with no information loss.

The only edge case where this differs from the real browser `_fbc` cookie: the millisecond timestamp embedded in our reconstructed value reflects the time of the webhook fire, not the time of the original click. Meta documents both as valid and doesn't appear to use the timestamp in matching — only the `fbclid` portion. EMQ impact: identical.

### Why we don't also store `gclid`

Dropped to make room for `fbp` (15-key limit). `gclid` is only useful for Google Ads CAPI, which this Meta-driven funnel doesn't fire. The verify-payment primary path still ships `gclid` to Pabbly from browser sessionStorage; only the rare webhook-fallback Pabbly row will have an empty `gclid`. Meta CAPI doesn't use `gclid` at all.

### Verification

In Meta Events Manager → your pixel → Overview → Purchase row → click "Manage" → "Other parameters":

- BEFORE the fix: `Click ID (fbc)` and `Browser ID (fbp)` listed under "Send additional parameters" with `~16% increase` / `~13% increase` callouts. EMQ on Purchase event shows ~7.5–8.5.
- AFTER the fix: `fbc` and `fbp` show as already-sending under "Customer information" with high `% of total events` (the percentage equals 1 − fraction of users whose browser didn't have a `_fbp` cookie yet — typically >95%). EMQ on Purchase event recovers to ~9.0–9.5.

Both verify-payment-path AND webhook-path fires now ship fbc + fbp. Symptom is gone.

### Important: this only helps the WEBHOOK path

The verify-payment path was already shipping fbc + fbp correctly from browser cookies. If your EMQ was already at 9.5 before, this fix doesn't change the verify-payment path's contribution. What it does change is the webhook-fallback path's contribution — that's where the EMQ drag was coming from.

The greater the proportion of webhook-fallback fires (i.e. the more mobile-heavy your traffic, since mobile tabs are the main reason verify-payment doesn't land), the bigger the EMQ recovery from this fix.
