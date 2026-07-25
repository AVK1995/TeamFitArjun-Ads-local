/**
 * Helpers for extracting client IP and User-Agent from a Next.js Request.
 * These are required for Meta CAPI user_data to score EMQ.
 */

export function extractClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    // First IP in the comma-separated list is the original client.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "";
}

export function extractUserAgent(request: Request): string {
  return request.headers.get("user-agent") ?? "";
}

export function extractEventSourceUrl(request: Request, fallback: string): string {
  return request.headers.get("referer") ?? fallback;
}

/**
 * Truncate a URL to its origin (scheme + host), dropping path and query.
 *
 * Required for every Meta CAPI event on this dataset: it is categorised
 * "Health and wellness condition", and Meta's "core setup" tier strips the
 * path/query server-side anyway. Sending it ourselves would only leak UTMs
 * and path segments into a payload we want maximally neutral — see
 * `clientConfig.capi.events`.
 *
 * Falls back to the production origin when the input is not a parseable URL.
 */
export function toOriginOnly(url: string, fallbackOrigin: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return fallbackOrigin;
  }
}
