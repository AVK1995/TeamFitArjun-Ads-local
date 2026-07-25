import { sha256Lower } from "./hash";
import type { CustomerPayload, UtmPayload } from "./types";

/**
 * POST the purchase payload to the Pabbly Connect webhook.
 *
 * Returns true when Pabbly returned a 2xx, false otherwise. The caller
 * (verify-payment / webhook routes) uses this boolean to decide whether
 * to set the `pabbly_fired` marker on the Razorpay payment — if Pabbly
 * was down, we leave the marker unset so the fallback path retries.
 */
export async function firePabblyWebhook(args: {
  customer: CustomerPayload;
  utm: UtmPayload;
  paymentId: string;
  orderId: string;
  amount: string;
  currency: string;
  timezone: string;
  coupon?: string;
  /**
   * Meta matching identifiers, forwarded into the CRM Sheet so the
   * downstream Apps Script can fire CallBooked / CallDone /
   * HighTicketPurchase at high EMQ. These are the SAME values the route
   * already passes to fireMetaCapi — no new data capture, just threaded
   * into the Pabbly body too. All optional; sent as "" when absent.
   */
  fbc?: string;
  fbp?: string;
  clientIp?: string;
  clientUserAgent?: string;
  eventSourceUrl?: string;
  /** Whether this was a test / bypass order (derived from amount <= 1). */
  isTest?: boolean;
}): Promise<boolean> {
  const url = process.env.PABBLY_WEBHOOK_URL;
  if (!url) {
    console.warn("[pabbly] PABBLY_WEBHOOK_URL not set — skipping");
    return false;
  }

  const now = new Date();
  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: args.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timeFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: args.timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const fullName = [args.customer.firstName, args.customer.lastName]
    .filter(Boolean)
    .join(" ");

  // external_id MUST be computed identically to the CAPI side
  // (sha256 of lowercase+trimmed email) so Meta links browser PageView,
  // the server `sales` event, and the downstream Apps Script events into one
  // user. lib/capi.ts uses the same sha256Lower(email).
  const externalId = args.customer.email ? sha256Lower(args.customer.email) : "";

  const payload = {
    // --- SOP canonical columns A–W (the downstream CRM/Apps-Script reads these) ---
    lead_id: args.paymentId,
    created_at: now.toISOString(),
    first_name: args.customer.firstName,
    last_name: args.customer.lastName,
    email: args.customer.email,
    phone: args.customer.phone,
    city: args.customer.city,
    country_code: args.customer.countryCode,
    fbc: args.fbc ?? "",
    fbp: args.fbp ?? "",
    client_ip_address: args.clientIp ?? "",
    client_user_agent: args.clientUserAgent ?? "",
    external_id: externalId,
    event_source_url: args.eventSourceUrl ?? "",
    amount: args.amount,
    is_test: String(Boolean(args.isTest)),
    purchase_event_id: args.paymentId,
    utm_source: args.utm.utm_source ?? "",
    utm_medium: args.utm.utm_medium ?? "",
    utm_campaign: args.utm.utm_campaign ?? "",
    utm_content: args.utm.utm_content ?? "",
    utm_term: args.utm.utm_term ?? "",
    fbclid: args.utm.fbclid ?? "",

    // --- Extra fields the funnel already sent (kept; Pabbly ignores unmapped) ---
    full_name: fullName,
    state: args.customer.state ?? "",
    zip_code: args.customer.zipCode ?? "",
    order_id: args.orderId,
    currency: args.currency,
    coupon: args.coupon ?? "",
    payment_date: dateFormatter.format(now),
    payment_time: timeFormatter.format(now),
    payment_timestamp: now.toISOString(),
    gclid: args.utm.gclid ?? "",
    referrer: args.utm.referrer ?? "",
    landing_url: args.utm.landing_url ?? "",
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      console.warn(
        `[pabbly] webhook returned ${res.status} for order ${args.orderId} — body: ${text.slice(0, 200)} — payload: ${JSON.stringify(payload)}`,
      );
      return false;
    }
    // Log the full payload on success so every Pabbly fire can be inspected
    // in Vercel logs. Helpful for reconciling missing rows + debugging
    // mapping issues in the Pabbly workflow.
    console.log(
      `[pabbly] OK order=${args.orderId} payment=${args.paymentId} payload=${JSON.stringify(payload)}`,
    );
    return true;
  } catch (err) {
    console.warn(
      `[pabbly] webhook failed for order ${args.orderId} — payload: ${JSON.stringify(payload)}`,
      err,
    );
    return false;
  }
}
