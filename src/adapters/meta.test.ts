// Meta adapter — validateWebhook hardening. Mirrors twilio.test.ts: skipping
// needs the explicit TWILIO_SKIP_WEBHOOK_VALIDATION=true opt-in AND a
// non-production NODE_ENV; the HMAC compare is length-guarded (a short header
// used to make crypto.timingSafeEqual THROW → 500 instead of a clean 403).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { createMetaAdapter, type MetaConfig } from './meta.js';

const cfg: MetaConfig = {
  accessToken: 'tok',
  phoneNumberId: '123',
  appSecret: 'app-secret',
  verifyToken: 'verify-me',
};

const ENV_KEYS = ['NODE_ENV', 'TWILIO_SKIP_WEBHOOK_VALIDATION'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.TWILIO_SKIP_WEBHOOK_VALIDATION;
  process.env.NODE_ENV = 'development';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
const goodSig =
  'sha256=' + crypto.createHmac('sha256', cfg.appSecret).update(rawBody).digest('hex');

const req = (signature?: string) => ({
  method: 'POST',
  body: JSON.parse(rawBody),
  rawBody,
  headers: signature ? { 'x-hub-signature-256': signature } : {},
});

describe('meta validateWebhook', () => {
  it('validates by default in development (no opt-in flag)', () => {
    const adapter = createMetaAdapter(cfg);
    expect(adapter.validateWebhook(req())).toBe(false);
    expect(adapter.validateWebhook(req(goodSig))).toBe(true);
  });

  it('short / wrong-length signature → false, never throws', () => {
    const adapter = createMetaAdapter(cfg);
    expect(() => adapter.validateWebhook(req('sha256=abc'))).not.toThrow();
    expect(adapter.validateWebhook(req('sha256=abc'))).toBe(false);
  });

  it('opt-in flag skips in non-production only', () => {
    process.env.TWILIO_SKIP_WEBHOOK_VALIDATION = 'true';
    expect(createMetaAdapter(cfg).validateWebhook(req())).toBe(true);
    process.env.NODE_ENV = 'production';
    expect(createMetaAdapter(cfg).validateWebhook(req())).toBe(false);
  });

  it('GET (verification handshake) always passes validation — the route checks the token', () => {
    const adapter = createMetaAdapter(cfg);
    expect(adapter.validateWebhook({ method: 'GET', body: {}, headers: {} })).toBe(true);
  });
});
