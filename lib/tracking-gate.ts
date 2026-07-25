import { clientConfig } from "@/client.config";

/**
 * Tracking gates that prevent Vercel preview deploys and ₹1 test
 * transactions from polluting Events Manager / Pabbly.
 *
 * Two independent checks:
 *   1. PRODUCTION HOST — the page (browser) or request (server) is being
 *      served from the production domain (e.g. teamfitarjun.com).
 *      Vercel `*.vercel.app` preview URLs and `localhost` fail this.
 *   2. PAID AMOUNT — the order amount is greater than ₹1. Real purchases
 *      are ₹97 so they pass; test transactions priced at ₹1 are dropped.
 *
 * Browser PageView is gated by HOST only (no amount exists pre-purchase).
 * Server conversion events (CAPI `sales`, Pabbly purchase) are
 * gated by BOTH host and amount.
 */

const PROD_HOST = clientConfig.brand.domain;

/** Browser: returns true only when the page is served from the production domain. */
export function isProductionClient(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.toLowerCase();
  return host === PROD_HOST || host.endsWith(`.${PROD_HOST}`);
}

/** Server: returns true when the incoming request was served from the production domain. */
export function isProductionServer(request: Request): boolean {
  const raw = (request.headers.get("host") ?? "").toLowerCase();
  // Strip any port (e.g. "teamfitarjun.com:443" → "teamfitarjun.com")
  const host = raw.split(":")[0];
  return host === PROD_HOST || host.endsWith(`.${PROD_HOST}`);
}

/** True only for real purchases (₹1 test transactions are excluded). */
export function isPaidAmount(amountRupees: number): boolean {
  return amountRupees > 1;
}
