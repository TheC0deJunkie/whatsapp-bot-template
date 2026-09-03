// Tests for Twilio adapter — locks the ALS-driven From-routing behaviour
// added in 260427-0r7 (dual-sender prod + sandbox on the same webhook).
//
// Strategy: stub global fetch so we can read the URLSearchParams.toString()
// off the request body and assert the From= line. Bypass the simulator
// branch (simActive defaults to false), so the real fetch path is exercised.
//
// Contract:
//   - Outside any runWithSender frame → From=whatsapp:<cfg.fromNumber>.
//   - Inside runWithSender({from:<sandbox>}) → From=whatsapp:<sandbox>.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { createTwilioAdapter, type TwilioConfig } from './twilio.js';
import { runWithSender } from '../core/sender-context.js';

const baseCfg: TwilioConfig = {
  accountSid: 'ACtest',
  apiKeySid: 'SKtest',
  apiKeySecret: 'secret',
  authToken: 'authtoken',
  fromNumber: '+15550009999',
  sandboxFromNumber: '+14155238886',
  sandboxJoinCode: 'apple-serious',
  defaultCountryCode: '27',
  skipValidationInDev: true,
};

describe('twilioSend — From routing via ALS sender frame', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sid: 'SMtest' }),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('outside any runWithSender frame → From defaults to prod sender', async () => {
    const adapter = createTwilioAdapter(baseCfg);
    await adapter.sendText('+27821234567', 'hi');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callBody = String(mockFetch.mock.calls[0]![1]!.body);
    // URLSearchParams percent-encodes `:` as %3A and `+` as %2B.
    expect(callBody).toContain('From=whatsapp%3A%2B15550009999');
    expect(callBody).not.toContain('From=whatsapp%3A%2B14155238886');
  });

  it('inside sandbox runWithSender frame → From routes to sandbox sender', async () => {
    const adapter = createTwilioAdapter(baseCfg);

    await runWithSender({ from: '+14155238886', isSandbox: true }, () =>
      adapter.sendText('+27821234567', 'hi'),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callBody = String(mockFetch.mock.calls[0]![1]!.body);
    expect(callBody).toContain('From=whatsapp%3A%2B14155238886');
    expect(callBody).not.toContain('From=whatsapp%3A%2B15550009999');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 260528-hxb — sendContentTemplate: Twilio Content API send by ContentSid
// (HX...) with optional ContentVariables. MUTUALLY EXCLUSIVE with Body —
// Twilio rejects 400 if both ContentSid and Body are present in the same
// request. Phase 2 wires welcome_unreferred_v1 / welcome_referred_v1 /
// add_circle_menu_v1 through this method when their cached approval is
// 'approved'; otherwise handlers fall back to free-form sendMedia/sendText.
// ─────────────────────────────────────────────────────────────────────────────

describe('sendContentTemplate — Twilio Content API by ContentSid (260528-hxb)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sid: 'SMcontent' }),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits ContentSid=HX... and NO Body / NO ContentVariables when called without vars', async () => {
    const adapter = createTwilioAdapter(baseCfg);
    await adapter.sendContentTemplate('+27821234567', 'HXabc123');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callBody = String(mockFetch.mock.calls[0]![1]!.body);
    expect(callBody).toContain('ContentSid=HXabc123');
    // CRITICAL invariant — Twilio rejects 400 with both ContentSid and Body.
    expect(callBody).not.toContain('Body=');
    expect(callBody).not.toContain('ContentVariables=');
  });

  it('emits ContentSid + ContentVariables (URL-encoded JSON) and NO Body when called with vars', async () => {
    const adapter = createTwilioAdapter(baseCfg);
    await adapter.sendContentTemplate('+27821234567', 'HXabc123', { '1': 'Alex' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callBody = String(mockFetch.mock.calls[0]![1]!.body);
    expect(callBody).toContain('ContentSid=HXabc123');
    // URLSearchParams encodes {"1":"Alex"} as %7B%221%22%3A%22Alex%22%7D.
    expect(callBody).toContain('ContentVariables=%7B%221%22%3A%22Alex%22%7D');
    expect(callBody).not.toContain('Body=');
  });

  it('omits ContentVariables when vars is an empty object', async () => {
    const adapter = createTwilioAdapter(baseCfg);
    await adapter.sendContentTemplate('+27821234567', 'HXabc123', {});

    const callBody = String(mockFetch.mock.calls[0]![1]!.body);
    expect(callBody).toContain('ContentSid=HXabc123');
    expect(callBody).not.toContain('ContentVariables=');
    expect(callBody).not.toContain('Body=');
  });

  it('outside any runWithSender frame → From defaults to prod sender', async () => {
    const adapter = createTwilioAdapter(baseCfg);
    await adapter.sendContentTemplate('+27821234567', 'HXabc123');

    const callBody = String(mockFetch.mock.calls[0]![1]!.body);
    expect(callBody).toContain('From=whatsapp%3A%2B15550009999');
    expect(callBody).not.toContain('From=whatsapp%3A%2B14155238886');
  });

  it('inside sandbox runWithSender frame → From routes to sandbox sender', async () => {
    const adapter = createTwilioAdapter(baseCfg);
    await runWithSender({ from: '+14155238886', isSandbox: true }, () =>
      adapter.sendContentTemplate('+27821234567', 'HXabc123'),
    );

    const callBody = String(mockFetch.mock.calls[0]![1]!.body);
    expect(callBody).toContain('From=whatsapp%3A%2B14155238886');
    expect(callBody).not.toContain('From=whatsapp%3A%2B15550009999');
  });

  it('returns { ok: true, sid } on Twilio 200', async () => {
    const adapter = createTwilioAdapter(baseCfg);
    const r = await adapter.sendContentTemplate('+27821234567', 'HXabc123');
    expect(r).toEqual({ ok: true, sid: 'SMcontent' });
  });

  it('returns { ok: false, error } on Twilio non-2xx', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ message: 'ContentSid and Body are mutually exclusive' }),
    });
    const adapter = createTwilioAdapter(baseCfg);
    const r = await adapter.sendContentTemplate('+27821234567', 'HXabc123');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('mutually exclusive');
  });
});

// 260616-glb — status-callback parse now carries SID/status/error so the
// engine can upsert the MessageDelivery row instead of dropping the callback.
describe('parseWebhook — status callback carries delivery fields', () => {
  const adapter = createTwilioAdapter(baseCfg);

  const parse = (body: Record<string, any>) =>
    adapter.parseWebhook({ body, headers: {} });

  it('delivered callback → isStatusCallback + sid + status', () => {
    const msg = parse({
      SmsStatus: 'delivered',
      MessageSid: 'SMabc',
      MessageStatus: 'delivered',
    });
    expect(msg).not.toBeNull();
    expect(msg!.isStatusCallback).toBe(true);
    expect(msg!.statusCallbackSid).toBe('SMabc');
    expect(msg!.statusCallbackStatus).toBe('delivered');
  });

  it('failed callback → carries errorCode + errorMessage', () => {
    const msg = parse({
      SmsStatus: 'failed',
      MessageSid: 'SMfail',
      MessageStatus: 'failed',
      ErrorCode: '63016',
      ErrorMessage: 'test msg',
    });
    expect(msg).not.toBeNull();
    expect(msg!.statusCallbackErrorCode).toBe('63016');
    expect(msg!.statusCallbackErrorMessage).toBe('test msg');
  });

  it('normal inbound message → statusCallbackSid is undefined', () => {
    const msg = parse({ From: 'whatsapp:+27821234567', Body: 'hello' });
    expect(msg).not.toBeNull();
    expect(msg!.isStatusCallback).toBe(false);
    expect(msg!.statusCallbackSid).toBeUndefined();
  });
});

// ── validateWebhook — signature check no longer hinges on NODE_ENV ──────────
// Skipping requires the explicit TWILIO_SKIP_WEBHOOK_VALIDATION=true opt-in AND
// a non-production NODE_ENV. Anything else validates the X-Twilio-Signature HMAC.
describe('validateWebhook — explicit opt-in skip, constant-time compare', () => {
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

  // Config WITHOUT the explicit skipValidationInDev override so the env gate
  // is what decides.
  const { skipValidationInDev: _drop, ...envGatedCfg } = baseCfg;
  const cfg: TwilioConfig = { ...envGatedCfg, webhookBaseUrl: 'https://bot.example' };

  function sign(url: string, body: Record<string, string>): string {
    const paramString = Object.keys(body)
      .sort()
      .reduce((acc, key) => acc + key + body[key], '');
    return crypto.createHmac('sha1', cfg.authToken).update(url + paramString).digest('base64');
  }

  const body = { From: 'whatsapp:+27821234567', Body: 'hi' };
  const req = (signature?: string) => ({
    body,
    headers: signature ? { 'x-twilio-signature': signature } : {},
    originalUrl: '/webhook',
    url: '/webhook',
  });

  it('development WITHOUT the opt-in flag → validates (bad/missing signature rejected)', () => {
    const adapter = createTwilioAdapter(cfg);
    expect(adapter.validateWebhook(req())).toBe(false);
    expect(adapter.validateWebhook(req('nope'))).toBe(false);
  });

  it('development WITHOUT the opt-in flag → a correct signature passes', () => {
    const adapter = createTwilioAdapter(cfg);
    const good = sign('https://bot.example/webhook', body);
    expect(adapter.validateWebhook(req(good))).toBe(true);
  });

  it('TWILIO_SKIP_WEBHOOK_VALIDATION=true in non-production → skips (dev simulator path)', () => {
    process.env.TWILIO_SKIP_WEBHOOK_VALIDATION = 'true';
    const adapter = createTwilioAdapter(cfg);
    expect(adapter.validateWebhook(req())).toBe(true);
  });

  it('TWILIO_SKIP_WEBHOOK_VALIDATION=true in PRODUCTION → still validates', () => {
    process.env.TWILIO_SKIP_WEBHOOK_VALIDATION = 'true';
    process.env.NODE_ENV = 'production';
    const adapter = createTwilioAdapter(cfg);
    expect(adapter.validateWebhook(req())).toBe(false);
    expect(adapter.validateWebhook(req(sign('https://bot.example/webhook', body)))).toBe(true);
  });

  it('explicit skipValidationInDev:true is ignored under NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    const adapter = createTwilioAdapter({ ...cfg, skipValidationInDev: true });
    expect(adapter.validateWebhook(req())).toBe(false);
  });

  it('a signature of the wrong length is rejected without throwing', () => {
    const adapter = createTwilioAdapter(cfg);
    expect(() => adapter.validateWebhook(req('x'))).not.toThrow();
    expect(adapter.validateWebhook(req('x'))).toBe(false);
  });
});
