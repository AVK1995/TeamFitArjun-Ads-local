import {
  sha256Lower,
  normalizePhoneForCapi,
  normalizeCityForCapi,
  normalizeStateForCapi,
  normalizeZipForCapi,
  normalizeCountryForCapi,
  normalizeNameForCapi,
} from "./hash";
import type { CustomerPayload } from "./types";
import { toOriginOnly } from "./request";
import { clientConfig } from "@/client.config";

const META_GRAPH_VERSION = "v25.0";

interface FireCapiArgs {
  customer: CustomerPayload;
  /**
   * Event names to fire in a single CAPI request. Each name becomes its own
   * entry in the `data: []` array — same event_id, same user_data, same
   * custom_data, same event_source_url.
   *
   * ⚠️ CUSTOM NAMES ONLY. For a paid order this is `["sales"]` (from
   * `clientConfig.capi.events.purchase`). The standard `Purchase` used to be
   * paired here and was REMOVED: this dataset is categorised "Health and
   * wellness condition" and Meta blocks standard events by name. Campaigns
   * now optimise on `sales` directly. Do not re-add `Purchase`.
   */
  eventNames: string[];
  /**
   * Deterministic event_id shared across every event in the batch. For paid
   * conversions this is the Razorpay payment_id.
   */
  eventId: string;
  value?: number;
  currency?: string;
  paymentId?: string;
  eventSourceUrl: string;
  clientIp: string;
  clientUserAgent: string;
  fbc?: string;
  fbp?: string;
  /** Test event code from Events Manager — only set in non-prod */
  testEventCode?: string;
}

/**
 * POST one or more events to Meta Conversions API in a single HTTPS call.
 *
 * Returns true when Meta returned a 2xx, false otherwise. The caller uses
 * this only for structured logging; Meta deduplicates by event_id on its
 * side so retries from our fallback paths cannot cause duplicate `sales`
 * events in Events Manager.
 *
 * EMQ payload (target ≥ 9.5):
 *   - Hashed: em, ph, fn, ln, ct, country, external_id (= sha256(email))
 *   - Raw context: fbc, fbp, client_ip_address, client_user_agent
 *   = 11 matching signals when the customer payload is fully populated.
 *
 * external_id is derived as sha256(normalised email) so it MATCHES the value
 * the browser MAM cookie carries — per Meta's external_id spec, the value
 * must be consistent across channels for the same user.
 */
export async function fireMetaCapi(args: FireCapiArgs): Promise<boolean> {
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;

  if (!pixelId || !accessToken) {
    console.warn(
      "[capi] NEXT_PUBLIC_META_PIXEL_ID or META_CAPI_ACCESS_TOKEN not set — skipping",
    );
    return false;
  }
  if (args.eventNames.length === 0) return false;

  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${pixelId}/events?access_token=${accessToken}`;

  // user_data: every field we have, hashed where Meta requires.
  const userData: Record<string, unknown> = {
    client_ip_address: args.clientIp,
    client_user_agent: args.clientUserAgent,
  };

  if (args.customer.email) {
    const emailHash = sha256Lower(args.customer.email);
    userData.em = [emailHash];
    // external_id = sha256(normalised email). Identical to the browser MAM
    // cookie value so Meta links sessions across browser PageView and
    // the server `sales` event for the same user.
    userData.external_id = [emailHash];
  }
  if (args.customer.phone) {
    userData.ph = [sha256Lower(normalizePhoneForCapi(args.customer.phone))];
  }
  if (args.customer.firstName) {
    userData.fn = [sha256Lower(normalizeNameForCapi(args.customer.firstName))];
  }
  if (args.customer.lastName) {
    userData.ln = [sha256Lower(normalizeNameForCapi(args.customer.lastName))];
  }
  if (args.customer.city) {
    userData.ct = [sha256Lower(normalizeCityForCapi(args.customer.city))];
  }
  if (args.customer.state) {
    userData.st = [sha256Lower(normalizeStateForCapi(args.customer.state))];
  }
  if (args.customer.zipCode) {
    userData.zp = [sha256Lower(normalizeZipForCapi(args.customer.zipCode))];
  }
  if (args.customer.countryCode) {
    userData.country = [sha256Lower(normalizeCountryForCapi(args.customer.countryCode))];
  }
  if (args.fbc) userData.fbc = args.fbc;
  if (args.fbp) userData.fbp = args.fbp;

  const customData: Record<string, unknown> = {};
  if (args.value !== undefined) customData.value = args.value;
  if (args.currency) customData.currency = args.currency;
  if (args.paymentId) customData.payment_id = args.paymentId;

  const baseEvent = {
    event_time: Math.floor(Date.now() / 1000),
    event_id: args.eventId,
    // Origin only — Meta's "core setup" tier strips the path/query on this
    // restricted dataset anyway; sending it would only leak UTMs and path
    // segments into a payload we want maximally neutral.
    event_source_url: toOriginOnly(
      args.eventSourceUrl,
      `https://${clientConfig.brand.domain}`,
    ),
    action_source: "website",
    user_data: userData,
    custom_data: customData,
  };

  const events = args.eventNames.map((name) => ({
    ...baseEvent,
    event_name: name,
  }));

  const body: Record<string, unknown> = { data: events };
  if (args.testEventCode) body.test_event_code = args.testEventCode;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      console.warn(
        `[capi] Meta returned ${res.status} for event_id ${args.eventId} (${args.eventNames.join(", ")}): ${text}`,
      );
      return false;
    }
    console.log(
      `[capi] OK event_id=${args.eventId} events=[${args.eventNames.join(", ")}]`,
    );
    return true;
  } catch (err) {
    console.warn("[capi] fire failed", err);
    return false;
  }
}
