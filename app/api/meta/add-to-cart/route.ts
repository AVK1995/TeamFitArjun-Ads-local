import { NextResponse } from "next/server";
import { sendAddToCartEvent } from "@/lib/meta-events";
import {
  extractClientIp,
  extractUserAgent,
  extractEventSourceUrl,
} from "@/lib/request";
import { isProductionServer, isPaidAmount } from "@/lib/tracking-gate";
import { clientConfig } from "@/client.config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side CAPI `atc_event` — fired when a visitor clicks any landing CTA.
 *
 * CUSTOM event name (from clientConfig.capi.events.addToCart), not Meta's
 * standard `AddToCart`: this dataset is categorised "Health and wellness
 * condition" and Meta blocks standard events by name.
 *
 * Client role: trigger only. The browser sends this POST via `sendBeacon` (or
 * `fetch keepalive`) so the request survives the CTA's navigation to
 * `/checkout`. All hashing + Meta Graph API POST happens here.
 *
 * Gates (identical to the `sales` pipeline in the Razorpay webhook):
 *   - production host (`teamfitarjun.com`) — preview + localhost skip
 *   - amount > ₹1 — ₹1 test transactions skip
 *
 * Failures never surface to the user. The response is best-effort JSON so
 * the browser's `sendBeacon` sees a 2xx even when Meta is down.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: { eventSourceUrl?: string } = {};
  try {
    body = (await request.json()) as { eventSourceUrl?: string };
  } catch {
    // sendBeacon with no body / bad JSON — non-fatal.
  }

  const onProductionHost = isProductionServer(request);
  const isRealPurchase = isPaidAmount(clientConfig.pricing.price);

  if (!onProductionHost || !isRealPurchase) {
    console.log(
      `[atc] tracking suppressed — onProductionHost=${onProductionHost}, isRealPurchase=${isRealPurchase}`,
    );
    return NextResponse.json({ ok: true, capi: "skipped" });
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const fbc = readCookie(cookieHeader, "_fbc");
  const fbp = readCookie(cookieHeader, "_fbp");

  const clientIp = extractClientIp(request);
  const clientUserAgent = extractUserAgent(request);
  const eventSourceUrl = extractEventSourceUrl(
    request,
    body.eventSourceUrl ?? `https://${clientConfig.brand.domain}/`,
  );

  console.log(
    `[atc] firing — fbp=${fbp ? "yes" : "no"}, fbc=${fbc ? "yes" : "no"}, ip=${clientIp ? "yes" : "no"}`,
  );

  const capi = await sendAddToCartEvent({
    eventSourceUrl,
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
