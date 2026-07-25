import { NextResponse } from "next/server";
import type Razorpay from "razorpay";
import { verifyRazorpayWebhookSignature, getRazorpay } from "@/lib/razorpay";
import { firePabblyWebhook } from "@/lib/pabbly";
import { fireMetaCapi } from "@/lib/capi";
import { claimEventId } from "@/lib/dedup";
import { getPaymentDedupState, markFires } from "@/lib/payment-dedup";
import { extractClientIp, extractUserAgent } from "@/lib/request";
import { buildFbcFromFbclid } from "@/lib/utm";
import { isProductionServer, isPaidAmount } from "@/lib/tracking-gate";
import { clientConfig } from "@/client.config";
import type { CustomerPayload, UtmPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Razorpay webhook receiver — server-side fallback for payment.captured.
 *
 * If verify-payment never reaches the server (mobile browser killed mid-
 * redirect, network drop, ad-blocker on checkout.js, etc.), this route
 * delivers the same complete Pabbly + CAPI payload using order notes that
 * create-order persisted at order-creation time.
 *
 * AWAIT pattern (same as verify-payment): we cannot use `void` because
 * Vercel kills in-flight promises once the route returns its response.
 * Razorpay's webhook tolerates a 5-10s response time so the await cost is
 * fine.
 *
 * Dedup (two layers, same as verify-payment):
 *   1. claimEventId(paymentId) — in-memory, per-Lambda-instance.
 *   2. getPaymentDedupState(paymentId) — persistent via Razorpay payment
 *      notes, shared with verify-payment so neither side double-fires.
 *
 * Mark-after-success: we set `pabbly_fired` only when Pabbly returned 2xx,
 * so a Pabbly outage doesn't block a future retry by the backfill script.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";

  if (!verifyRazorpayWebhookSignature({ body: rawBody, signature })) {
    console.warn("[webhook] invalid signature");
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  if (payload.event !== "payment.captured") {
    return NextResponse.json({ ok: true, ignored: payload.event });
  }

  const payment = payload.payload?.payment?.entity;
  if (!payment) {
    return NextResponse.json({ ok: false, error: "missing payment entity" }, { status: 400 });
  }

  const orderId = payment.order_id;
  const paymentId = payment.id;
  const eventId = paymentId;

  console.log(
    `[webhook] received ${payload.event} for paymentId=${paymentId} orderId=${orderId}`,
  );

  // FIRST: confirm this payment belongs to OUR funnel. Razorpay webhook
  // subscriptions are account-level, so the same webhook URL receives
  // payment.captured events for every business that shares this account
  // (WooCommerce, other funnels, etc). We stamp `notes.funnel = slug` in
  // create-order; if it's not set or doesn't match, this is some other
  // business's payment and we MUST NOT fire Pabbly + CAPI for it.
  //
  // We fetch order notes BEFORE claiming the eventId or doing any dedup
  // work, so unrelated payments cost us exactly one Razorpay API call
  // and zero outbound Pabbly/CAPI traffic.
  const orderNotes = await fetchOrderNotesWithRetry(orderId);
  const expectedFunnel = clientConfig.funnel.slug;

  if (orderNotes.funnel !== expectedFunnel) {
    console.log(
      `[webhook] ignoring payment ${paymentId} — order ${orderId} is NOT from our funnel ` +
        `(notes.funnel=${orderNotes.funnel ?? "<unset>"}, expected=${expectedFunnel})`,
    );
    return NextResponse.json({ ok: true, ignored: "not_our_funnel" });
  }

  // Layer 1 dedup — in-process. Only claim after we know it's our funnel,
  // otherwise the in-memory Map would fill up with payment_ids we never
  // intended to process.
  if (!claimEventId(eventId)) {
    console.log(
      `[webhook] event_id ${eventId} already claimed in-memory — skipping`,
    );
    return NextResponse.json({ ok: true, deduped: "memory" });
  }

  // Layer 2 dedup — persistent via Razorpay payment notes.
  const dedupState = await getPaymentDedupState(paymentId);

  if (dedupState.pabblyFired && dedupState.capiFired) {
    console.log(
      `[webhook] payment ${paymentId} already has BOTH fires marked by verify-payment — full skip`,
    );
    return NextResponse.json({ ok: true, deduped: "razorpay" });
  }

  const customer: CustomerPayload = {
    firstName: orderNotes.first_name ?? "",
    lastName: orderNotes.last_name ?? "",
    email: String(payment.email ?? orderNotes.customer_email ?? ""),
    phone: String(payment.contact ?? orderNotes.customer_phone ?? ""),
    countryCode: orderNotes.country_code || "IN",
    city: orderNotes.city ?? "",
  };

  const utm: UtmPayload = {
    utm_source: orderNotes.utm_source ?? "",
    utm_medium: orderNotes.utm_medium ?? "",
    utm_campaign: orderNotes.utm_campaign ?? "",
    utm_content: orderNotes.utm_content ?? "",
    utm_term: orderNotes.utm_term ?? "",
    fbclid: orderNotes.fbclid ?? "",
    gclid: orderNotes.gclid ?? "",
    landing_url: orderNotes.landing_url ?? "",
    // `referrer` was dropped from Razorpay notes to make room for the
    // `funnel` guardrail (15-key limit). Webhook-fallback fires therefore
    // ship referrer="". The primary verify-payment path still includes
    // referrer from the browser's sessionStorage.
    referrer: "",
  };

  if (!customer.firstName && !customer.lastName) {
    console.warn(
      `[webhook] order ${orderId} notes missing identity fields — Pabbly row will be partial. Investigate create-order body or Razorpay orders.fetch behavior.`,
    );
  }

  if (!customer.email && !customer.phone) {
    console.warn(`[webhook] no contact info for order ${orderId} — skipping`);
    return NextResponse.json({ ok: true, skipped: "no contact info" });
  }

  const clientIp = extractClientIp(request);
  const clientUserAgent = extractUserAgent(request);
  const eventSourceUrl = `https://${clientConfig.brand.domain}/thank-you`;
  const valueRupees = (payment.amount ?? clientConfig.pricing.paise) / 100;

  // Recover fbc + fbp for Meta CAPI from order notes (set at create-order
  // time by CheckoutView). Razorpay's webhook payload itself carries
  // neither — fbc/fbp are browser cookies and the webhook is server-to-
  // server, so without this recovery step the webhook-path CAPI fire
  // would lose Meta's ~13% (fbp) + ~16% (fbc) EMQ boost.
  //
  // fbc is reconstructed from fbclid using Meta's documented format:
  // `fb.1.{unix_ms}.{fbclid}`. This is exactly what the browser-side
  // _fbc cookie would contain.
  const fbp = orderNotes.fbp ?? "";
  const fbc = buildFbcFromFbclid(orderNotes.fbclid) ?? "";

  const onProductionHost = isProductionServer(request);
  const isRealPurchase = isPaidAmount(valueRupees);

  if (!(onProductionHost && isRealPurchase)) {
    console.log(
      `[webhook] tracking suppressed — onProductionHost=${onProductionHost}, isRealPurchase=${isRealPurchase} (value=${valueRupees})`,
    );
    return NextResponse.json({ ok: true, suppressed: true });
  }

  const willFirePabbly = !dedupState.pabblyFired;
  const willFireCapi = !dedupState.capiFired && clientConfig.capi.enabled;

  console.log(
    `[webhook] event_id=${eventId} value=${valueRupees} email=${customer.email} — firing { pabbly:${willFirePabbly}, capi:${willFireCapi} }`,
  );

  const pabblyTask: Promise<boolean> = willFirePabbly
    ? firePabblyWebhook({
        customer,
        utm,
        paymentId,
        orderId,
        amount: String(valueRupees),
        currency: String(payment.currency ?? clientConfig.pricing.currency),
        timezone: clientConfig.event.timezone,
        // Same Meta matching identifiers as the verify-payment path — fbc/fbp
        // are recovered from order notes above, ip/ua from the request. This
        // keeps webhook-fallback CRM rows identical to primary-path rows so
        // the downstream Apps Script fires CallBooked/CallDone/HighTicket at
        // full EMQ regardless of which route created the row.
        fbc: fbc || undefined,
        fbp: fbp || undefined,
        clientIp,
        clientUserAgent,
        eventSourceUrl,
        isTest: valueRupees <= 1,
      })
    : Promise.resolve(false);

  const capiTask: Promise<boolean> = willFireCapi
    ? fireMetaCapi({
        customer,
        // Custom event ONLY. The standard `Purchase` was removed when this
        // dataset was categorised "Health and wellness condition" — Meta
        // blocks standard events by name. See clientConfig.capi.events.
        eventNames: [clientConfig.capi.events.purchase],
        eventId,
        value: valueRupees,
        currency: String(payment.currency ?? clientConfig.pricing.currency),
        paymentId,
        eventSourceUrl,
        clientIp,
        clientUserAgent,
        fbc: fbc || undefined,
        fbp: fbp || undefined,
        testEventCode: process.env.META_CAPI_TEST_EVENT_CODE,
      })
    : Promise.resolve(false);

  const [pabblyResult, capiResult] = await Promise.allSettled([pabblyTask, capiTask]);

  if (pabblyResult.status === "rejected") {
    console.error(
      `[webhook] Pabbly fire REJECTED for ${paymentId}`,
      pabblyResult.reason,
    );
  }
  if (capiResult.status === "rejected") {
    console.error(
      `[webhook] CAPI fire REJECTED for ${paymentId}`,
      capiResult.reason,
    );
  }

  const pabblySucceeded =
    willFirePabbly &&
    pabblyResult.status === "fulfilled" &&
    pabblyResult.value === true;
  const capiSucceeded =
    willFireCapi &&
    capiResult.status === "fulfilled" &&
    capiResult.value === true;

  await markFires(paymentId, dedupState.existingNotes, {
    pabblySucceeded,
    capiSucceeded,
  });

  if (willFirePabbly && !pabblySucceeded) {
    console.warn(
      `[webhook] Pabbly fire did NOT succeed for ${paymentId} — leaving pabbly_fired UNSET so the backfill script can retry`,
    );
  }
  if (willFireCapi && !capiSucceeded) {
    console.warn(
      `[webhook] CAPI fire did NOT succeed for ${paymentId} — leaving capi_fired UNSET`,
    );
  }

  console.log(
    `[webhook] complete for event_id=${eventId} — pabblySucceeded=${pabblySucceeded} capiSucceeded=${capiSucceeded}`,
  );
  return NextResponse.json({ ok: true, eventId });
}

/**
 * orders.fetch with one retry. Razorpay's API occasionally returns a transient
 * 5xx or rate-limit error; a single retry after 300ms typically resolves it
 * without delaying the webhook response noticeably.
 */
async function fetchOrderNotesWithRetry(orderId: string): Promise<Record<string, string>> {
  let razorpay: Razorpay;
  try {
    razorpay = getRazorpay();
  } catch (err) {
    console.error("[webhook] Razorpay SDK init failed", err);
    return {};
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const order = await razorpay.orders.fetch(orderId);
      return (order.notes ?? {}) as Record<string, string>;
    } catch (err) {
      if (attempt === 0) {
        console.warn(
          `[webhook] orders.fetch(${orderId}) failed on attempt 1 — retrying in 300ms`,
          err,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      console.error(
        `[webhook] orders.fetch(${orderId}) failed twice — returning empty notes`,
        err,
      );
      return {};
    }
  }
  return {};
}

interface WebhookPayload {
  event: string;
  payload?: {
    payment?: {
      entity?: {
        id: string;
        order_id: string;
        amount: number;
        currency: string;
        email?: string;
        contact?: string;
      };
    };
  };
}
