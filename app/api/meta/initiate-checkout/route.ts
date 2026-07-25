import { NextResponse } from "next/server";
import { sendInitiateCheckoutEvent } from "@/lib/meta-events";
import {
  extractClientIp,
  extractUserAgent,
  extractEventSourceUrl,
} from "@/lib/request";
import { isProductionServer, isPaidAmount } from "@/lib/tracking-gate";
import { clientConfig } from "@/client.config";
import type { CustomerPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InitiateCheckoutBody {
  customer: CustomerPayload;
  eventSourceUrl?: string;
}

/**
 * Server-side CAPI `ic_event` — fired when the visitor clicks Pay
 * on /checkout AFTER validation passes (client-side dedup: one per email
 * per browser via localStorage).
 *
 * CUSTOM event name (from clientConfig.capi.events.initiateCheckout), not
 * Meta's standard `InitiateCheckout`: this dataset is categorised "Health and
 * wellness condition" and Meta blocks standard events by name.
 *
 * Full 11-signal EMQ payload:
 *   - hashed em, ph, fn, ln, ct, country, external_id (= sha256(email))
 *   - raw fbc, fbp, client_ip_address, client_user_agent
 *
 * `external_id` uses the SAME derivation as `sales` in lib/capi.ts so Meta
 * stitches this visitor's intent and purchase into one identity.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: InitiateCheckoutBody;
  try {
    body = (await request.json()) as InitiateCheckoutBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { customer, eventSourceUrl } = body;

  if (!customer?.email) {
    return NextResponse.json(
      { ok: false, error: "Missing customer.email" },
      { status: 400 },
    );
  }

  const onProductionHost = isProductionServer(request);
  const isRealPurchase = isPaidAmount(clientConfig.pricing.price);

  if (!onProductionHost || !isRealPurchase) {
    console.log(
      `[ic] tracking suppressed — onProductionHost=${onProductionHost}, isRealPurchase=${isRealPurchase}`,
    );
    return NextResponse.json({ ok: true, capi: "skipped" });
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const fbc = readCookie(cookieHeader, "_fbc");
  const fbp = readCookie(cookieHeader, "_fbp");

  const clientIp = extractClientIp(request);
  const clientUserAgent = extractUserAgent(request);
  const sourceUrl = extractEventSourceUrl(
    request,
    eventSourceUrl ?? `https://${clientConfig.brand.domain}/checkout`,
  );

  console.log(
    `[ic] firing — email=${customer.email}, fbp=${fbp ? "yes" : "no"}, fbc=${fbc ? "yes" : "no"}`,
  );

  const capi = await sendInitiateCheckoutEvent({
    customer,
    eventSourceUrl: sourceUrl,
    clientIp,
    clientUserAgent,
    fbc,
    fbp,
    testEventCode: process.env.META_CAPI_TEST_EVENT_CODE,
  });

  return NextResponse.json({ ok: true, capi });
}

function readCookie(cookieHeader: string, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${name}=([^;]+)`),
  );
  return match ? decodeURIComponent(match[1]) : undefined;
}
