// Twilio request-signature helpers, shared by the message webhook adapter
// (src/adapters/twilio.ts validateWebhook) and the delivery status-callback
// route (src/routes/twilio-status.ts). One implementation so the two endpoints
// can never drift on the scheme: HMAC-SHA1(authToken, fullUrl + sorted
// key+value concatenation of the POST params), base64.
//
// See https://www.twilio.com/docs/usage/webhooks/webhooks-security

import crypto from 'crypto';

/** Minimal request shape the URL reconstruction needs (Express-compatible). */
export interface SignedRequestLike {
  headers: Record<string, string | string[] | undefined>;
  originalUrl?: string;
  url?: string;
  protocol?: string;
}

// The URL Twilio signed is the exact public URL it POSTed to (including query
// string). Behind Vercel the Express-observed protocol/host can differ from
// the public one, so prefer the configured WEBHOOK_BASE_URL when present.
export function twilioSignedUrl(req: SignedRequestLike, webhookBaseUrl?: string): string {
  const path = req.originalUrl || req.url || '/';
  if (webhookBaseUrl && req.originalUrl) {
    return `${webhookBaseUrl.replace(/\/$/, '')}${req.originalUrl}`;
  }
  const protocol = req.protocol || 'https';
  return `${protocol}://${req.headers.host}${path}`;
}

export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, unknown> | undefined,
): string {
  const body = params ?? {};
  const paramString = Object.keys(body)
    .sort()
    .reduce((acc, key) => acc + key + String(body[key]), '');
  return crypto.createHmac('sha1', authToken).update(url + paramString).digest('base64');
}

// Constant-time compare — a signature check is exactly where a timing oracle
// would matter. Length mismatch is an immediate (safe) reject.
export function isValidTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, unknown> | undefined,
  signature: string | string[] | undefined,
): boolean {
  if (!signature || typeof signature !== 'string' || !authToken) return false;
  const expected = computeTwilioSignature(authToken, url, params);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
