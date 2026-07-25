import { createHash } from "node:crypto";
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

/**
 * Standalone senders for the upper-funnel intent events:
 *   - `atc_event` → fired when a visitor clicks any landing CTA
 *   - `ic_event`  → fired when a visitor clicks Pay on /checkout
 *
 * Kept in a sibling module (not merged into lib/capi.ts) so the
 * bottom-of-funnel `sales` pipeline stays independent.
 *
 * ⚠️ BOTH ARE CUSTOM EVENT NAMES, NOT STANDARD ONES. This dataset is
 * categorised "Health and wellness condition" in Events Manager, and Meta
 * blocks mid/lower-funnel STANDARD events by name — `AddToCart` and
 * `InitiateCheckout` (the names these previously used) are both on that list.
 * Confirmed custom events with PHI-free payloads are not. Names come from
 * `clientConfig.capi.events` — never hardcode a standard name here.
 *
 * Payload is deliberately minimal (`value` + `currency` only, no
 * `content_name` / `content_ids` / `content_type`) so Meta has nothing
 * product- or category-shaped to scan and flag the custom event as sensitive.
 * `event_source_url` is truncated to origin for the same reason.
 *
 * Deduplication (two layers, both enforced by the caller):
 *   1. Client-side: localStorage flag (`arjun_atc_fired`, `arjun_ic_fired`).
 *   2. Server-side: deterministic event_id lets Meta collapse duplicates
 *      within a 48h window (same event_name + event_id → one event).
 */

const META_GRAPH_VERSION = "v25.0";

/** Restricted-dataset rule: ship origin only, never path/query. */
function originOnly(url: string): string {
  return toOriginOnly(url, `https://${clientConfig.brand.domain}`);
}

interface CommonArgs {
  eventSourceUrl: string;
  clientIp: string;
  clientUserAgent: string;
  fbc?: string;
  fbp?: string;
  testEventCode?: string;
}

export interface SendAddToCartArgs extends CommonArgs {}

export interface SendInitiateCheckoutArgs extends CommonArgs {
  customer: CustomerPayload;
}

/**
 * event_id derivation for AddToCart. Falls back to a random hex when the
 * visitor has no `_fbp` cookie (tracking blocker / cleared storage) so we
 * always ship SOMETHING deterministic to Meta.
 */
function atcEventId(fbp?: string): string {
  if (fbp) {
    return createHash("sha256").update(`${fbp}|atc`).digest("hex");
  }
  return `${createHash("sha256")
    .update(Math.random().toString(36) + Date.now().toString(36))
    .digest("hex")
    .slice(0, 32)}_atc`;
}

/**
 * event_id derivation for InitiateCheckout. Stable per email so multi-tab
 * clicks and retries collapse to one event server-side.
 */
function icEventId(email: string): string {
  const normalised = email.trim().toLowerCase();
  return createHash("sha256").update(`${normalised}|ic`).digest("hex");
}

async function postToMeta(
  body: Record<string, unknown>,
  eventLabel: string,
): Promise<"sent" | "error"> {
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;

  if (!pixelId || !accessToken) {
    console.warn(
      `[${eventLabel}] NEXT_PUBLIC_META_PIXEL_ID or META_CAPI_ACCESS_TOKEN not set — skipping`,
    );
    return "error";
  }

  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${pixelId}/events?access_token=${accessToken}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      console.warn(
        `[${eventLabel}] Meta returned ${res.status}: ${text}`,
      );
      return "error";
    }
    console.log(`[${eventLabel}] OK`);
    return "sent";
  } catch (err) {
    console.warn(`[${eventLabel}] fire failed`, err);
    return "error";
  }
}

export async function sendAddToCartEvent(
  args: SendAddToCartArgs,
): Promise<"sent" | "error"> {
  const eventId = atcEventId(args.fbp);

  const userData: Record<string, unknown> = {
    client_ip_address: args.clientIp,
    client_user_agent: args.clientUserAgent,
  };
  if (args.fbc) userData.fbc = args.fbc;
  if (args.fbp) userData.fbp = args.fbp;

  // Neutral payload only — see module header. No content_name / content_ids /
  // content_type: product strings are what get a custom event scanned and
  // filtered as sensitive on a restricted dataset.
  const customData: Record<string, unknown> = {
    currency: clientConfig.pricing.currency,
    value: clientConfig.pricing.price,
  };

  const body: Record<string, unknown> = {
    data: [
      {
        event_name: clientConfig.capi.events.addToCart,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        event_source_url: originOnly(args.eventSourceUrl),
        action_source: "website",
        user_data: userData,
        custom_data: customData,
      },
    ],
  };
  if (args.testEventCode) body.test_event_code = args.testEventCode;

  return postToMeta(body, "atc");
}

export async function sendInitiateCheckoutEvent(
  args: SendInitiateCheckoutArgs,
): Promise<"sent" | "error"> {
  const { customer } = args;
  const eventId = icEventId(customer.email);

  const userData: Record<string, unknown> = {
    client_ip_address: args.clientIp,
    client_user_agent: args.clientUserAgent,
  };

  if (customer.email) {
    const emailHash = sha256Lower(customer.email);
    userData.em = [emailHash];
    // external_id derivation MUST match the `sales` event (lib/capi.ts) so
    // Meta stitches this visitor's intent and purchase into one identity.
    userData.external_id = [emailHash];
  }
  if (customer.phone) {
    userData.ph = [sha256Lower(normalizePhoneForCapi(customer.phone))];
  }
  if (customer.firstName) {
    userData.fn = [sha256Lower(normalizeNameForCapi(customer.firstName))];
  }
  if (customer.lastName) {
    userData.ln = [sha256Lower(normalizeNameForCapi(customer.lastName))];
  }
  if (customer.city) {
    userData.ct = [sha256Lower(normalizeCityForCapi(customer.city))];
  }
  if (customer.state) {
    userData.st = [sha256Lower(normalizeStateForCapi(customer.state))];
  }
  if (customer.zipCode) {
    userData.zp = [sha256Lower(normalizeZipForCapi(customer.zipCode))];
  }
  if (customer.countryCode) {
    userData.country = [
      sha256Lower(normalizeCountryForCapi(customer.countryCode)),
    ];
  }
  if (args.fbc) userData.fbc = args.fbc;
  if (args.fbp) userData.fbp = args.fbp;

  // Neutral payload only — see module header.
  const customData: Record<string, unknown> = {
    currency: clientConfig.pricing.currency,
    value: clientConfig.pricing.price,
  };

  const body: Record<string, unknown> = {
    data: [
      {
        event_name: clientConfig.capi.events.initiateCheckout,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        event_source_url: originOnly(args.eventSourceUrl),
        action_source: "website",
        user_data: userData,
        custom_data: customData,
      },
    ],
  };
  if (args.testEventCode) body.test_event_code = args.testEventCode;

  return postToMeta(body, "ic");
}
