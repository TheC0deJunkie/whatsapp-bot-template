import type {
  ProviderAdapter,
  IncomingRequest,
  IncomingMessage,
  MessageResult,
  MenuButton,
  WebhookResponse,
} from '../core/types.js';
import { normalizePhone, stripWhatsAppPrefix } from '../core/phone.js';
import {
  getActiveSender,
  runWithSender,
  type SenderFrame,
} from '../core/sender-context.js';
import { logMessage } from '../services/message-log.js';
import { seedDelivery } from '../services/delivery-log.js';
import { isValidTwilioSignature, twilioSignedUrl } from './twilio-signature.js';
import { isProduction, webhookValidationSkipped } from '../lib/env-guards.js';

// ── Configuration ─────────────────────────────────────────────

export interface TwilioConfig {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  authToken: string;
  fromNumber: string;
  /** Optional Twilio Shared Sandbox sender (e.g. '+14155238886'). When inbound
   *  webhook hits this number, replies route here too and the share link gets
   *  rewritten with the join-code prefix. Omit to disable sandbox routing. */
  sandboxFromNumber?: string;
  /** Twilio sandbox join phrase (e.g. 'apple-serious'). Required to make the
   *  wa.me prefill open the chat AND auto-enroll the recipient in the sandbox. */
  sandboxJoinCode?: string;
  /** Base URL for webhook validation (e.g. https://your-domain.com) */
  webhookBaseUrl?: string;
  /** Default country code for phone normalization (default: '27') */
  defaultCountryCode?: string;
  /** Skip webhook signature validation. Default derives from the explicit
   *  TWILIO_SKIP_WEBHOOK_VALIDATION=true opt-in (env-guards.ts). Even when
   *  set to true here, validation is NEVER skipped under NODE_ENV=production. */
  skipValidationInDev?: boolean;
}

// ── Simulator Intercept ───────────────────────────────────────

interface SimMessage {
  to: string;
  body: string;
  method: string;
}

let simActive = false;
let simMessages: SimMessage[] = [];

export function startSimCapture() {
  simActive = true;
  simMessages = [];
}

export function stopSimCapture(): SimMessage[] {
  simActive = false;
  const msgs = [...simMessages];
  simMessages = [];
  return msgs;
}

export function isSimActive(): boolean {
  return simActive;
}

// ── Debug Callback ────────────────────────────────────────────

type DebugCallback = (entry: {
  ts: string;
  direction: 'outbound';
  to: string;
  method: string;
  body?: string;
}) => void;

let debugCallback: DebugCallback | null = null;

export function setTwilioDebugCallback(cb: DebugCallback) {
  debugCallback = cb;
}

// ── Adapter Factory ───────────────────────────────────────────

export function createTwilioAdapter(cfg: TwilioConfig): ProviderAdapter {
  const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`;
  const authHeader =
    'Basic ' +
    Buffer.from(`${cfg.apiKeySid}:${cfg.apiKeySecret}`).toString('base64');
  const fromWa = `whatsapp:${cfg.fromNumber}`;
  const sandboxFromWa = cfg.sandboxFromNumber
    ? `whatsapp:${cfg.sandboxFromNumber}`
    : null;
  const countryCode = cfg.defaultCountryCode ?? '27';

  // Validation is skipped ONLY on explicit opt-in AND outside production —
  // a missing NODE_ENV on a real deployment must still validate. Resolved
  // per call (env can lag module import on a Vercel cold start).
  let warnedSkip = false;
  function shouldSkipValidation(): boolean {
    const skip =
      cfg.skipValidationInDev === undefined
        ? webhookValidationSkipped()
        : cfg.skipValidationInDev && !isProduction();
    if (skip && !warnedSkip) {
      warnedSkip = true;
      console.warn(
        '[twilio] WARNING: webhook signature validation is DISABLED ' +
          '(TWILIO_SKIP_WEBHOOK_VALIDATION=true / skipValidationInDev). ' +
          'Anyone who can reach /webhook can impersonate Twilio. Dev only.',
      );
    }
    return skip;
  }

  // ── Internal send helper ──────────────────────────────────
  async function twilioSend(
    to: string,
    params: Record<string, string>,
    method: string,
  ): Promise<MessageResult> {
    const toWa = `whatsapp:${normalizePhone(to, countryCode)}`;

    // Simulator intercept
    if (simActive) {
      simMessages.push({ to: toWa, body: params.Body || '', method });
      return { ok: true };
    }

    // Resolve the outbound `From` line from the request-scoped ALS frame set
    // by createTwilioWebhookHandler. Calls outside any frame (cron, scripts)
    // default to the primary prod sender — this keeps reminder cron sends
    // pinned to prod regardless of what sandbox traffic is in flight.
    const active = getActiveSender();
    const fromForThisCall = active?.from
      ? `whatsapp:${active.from}`
      : fromWa;

    const body = new URLSearchParams({
      To: toWa,
      From: fromForThisCall,
      ...params,
    });

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      const json = await res.json();

      if (!res.ok) {
        console.error('[twilio] send error:', json);
        return {
          ok: false,
          error: json.message || `HTTP ${res.status}`,
        };
      }

      // Fire debug callback
      if (debugCallback) {
        debugCallback({
          ts: new Date().toISOString(),
          direction: 'outbound',
          to: toWa,
          method,
          body: params.Body,
        });
      }

      // 260610-o06 — Persist outbound message to the Message log. Fire-and-forget.
      // Strip the whatsapp: prefix from toWa to store normalized E.164.
      logMessage({
        phone: stripWhatsAppPrefix(toWa),
        direction: 'outbound',
        body: params.Body ?? '',
        method,
      });

      // 260616-glb — Seed the delivery lifecycle row keyed by the provider SID.
      // Fire-and-forget (same contract as logMessage) — never blocks the send.
      // Twilio status callbacks later upsert this row by SID.
      if (json.sid) {
        seedDelivery({
          sid: json.sid,
          phone: stripWhatsAppPrefix(toWa),
          method,
        });
      }

      return { ok: true, sid: json.sid };
    } catch (err: any) {
      console.error('[twilio] fetch error:', err);
      return { ok: false, error: err.message };
    }
  }

  // ── Provider Adapter Implementation ───────────────────────
  return {
    async sendText(to: string, text: string): Promise<MessageResult> {
      return twilioSend(to, { Body: text }, 'sendText');
    },

    async sendInteractive(
      to: string,
      bodyText: string,
      buttons: MenuButton[],
    ): Promise<MessageResult> {
      // WhatsApp doesn't support native interactive buttons via Twilio SMS API.
      // Render as numbered text list — proven pattern from production.
      const capped = buttons.slice(0, 10);
      const lines = capped.map(
        (b, i) => `*[${i + 1}]* ${b.title}`,
      );
      const full = bodyText
        ? `${bodyText}\n\n${lines.join('\n')}`
        : lines.join('\n');

      return twilioSend(to, { Body: full }, 'sendInteractive');
    },

    async sendMedia(
      to: string,
      text: string,
      mediaUrl: string,
    ): Promise<MessageResult> {
      return twilioSend(
        to,
        { Body: text, MediaUrl: mediaUrl },
        'sendMedia',
      );
    },

    // 260615-ord2 — read a single message's delivery status so the caller can
    // wait for a media send to leave the queue before sending the next message
    // (fixes images delivering AFTER the menu). GET the per-message resource.
    async getMessageStatus(sid: string): Promise<string | null> {
      if (simActive) return 'sent'; // simulator: nothing actually queued
      try {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages/${sid}.json`;
        const res = await fetch(url, {
          headers: { Authorization: authHeader },
        });
        if (!res.ok) return null;
        const json = await res.json();
        return typeof json.status === 'string' ? json.status : null;
      } catch (err: any) {
        console.error('[twilio] getMessageStatus error:', err.message);
        return null;
      }
    },

    async sendTemplate(
      to: string,
      contentSid: string,
      variables?: Record<string, string>,
    ): Promise<MessageResult> {
      const params: Record<string, string> = { ContentSid: contentSid };
      if (variables) {
        params.ContentVariables = JSON.stringify(variables);
      }
      return twilioSend(to, params, 'sendTemplate');
    },

    // 260528-hxb — Phase 2 Content API send path. Identical wire shape to
    // sendTemplate (both POST ContentSid via twilioSend) but kept as its own
    // method so the handler-facing contract is unambiguous: callers know
    // they're sending a pre-approved Content-API template by SID, not a
    // legacy Meta-style template by name. CRITICAL invariant: do NOT include
    // a Body param — Twilio returns HTTP 400 with both ContentSid and Body.
    async sendContentTemplate(
      to: string,
      contentSid: string,
      contentVariables?: Record<string, string>,
    ): Promise<MessageResult> {
      const params: Record<string, string> = { ContentSid: contentSid };
      if (contentVariables && Object.keys(contentVariables).length > 0) {
        params.ContentVariables = JSON.stringify(contentVariables);
      }
      return twilioSend(to, params, 'sendContentTemplate');
    },

    validateWebhook(req: IncomingRequest): boolean {
      if (shouldSkipValidation()) return true;

      // 260815 — shared with POST /api/twilio-status (twilio-signature.ts) so
      // both Twilio-facing endpoints validate identically.
      return isValidTwilioSignature(
        cfg.authToken,
        twilioSignedUrl(req, cfg.webhookBaseUrl),
        req.body,
        req.headers['x-twilio-signature'],
      );
    },

    parseWebhook(req: IncomingRequest): IncomingMessage | null {
      const b = req.body || {};

      // Status callback check — carry the delivery fields (260616-glb) so the
      // engine can upsert the MessageDelivery row by SID instead of dropping it.
      if (b.SmsStatus && !b.Body && !b.ButtonPayload) {
        return {
          from: '',
          body: '',
          buttonPayload: '',
          isStatusCallback: true,
          statusCallbackSid: b.MessageSid ?? b.SmsSid ?? undefined,
          statusCallbackStatus: b.MessageStatus ?? b.SmsStatus ?? undefined,
          statusCallbackErrorCode: b.ErrorCode ? String(b.ErrorCode) : undefined,
          statusCallbackErrorMessage: b.ErrorMessage ?? undefined,
        };
      }

      const rawFrom = String(b.From || '');
      if (!rawFrom) return null;

      const from = normalizePhone(rawFrom, countryCode);

      // Capture which Twilio sender the user texted — drives ALS-based
      // outbound routing in createTwilioWebhookHandler.
      const rawTo = String(b.To || '');
      const to = rawTo ? normalizePhone(rawTo, countryCode) : undefined;

      // Twilio sends button payloads in multiple possible fields
      const buttonPayload =
        b.ButtonPayload ||
        b.ButtonText ||
        b.Payload ||
        b.ListId ||
        '';

      const location =
        b.Latitude && b.Longitude
          ? {
              latitude: parseFloat(b.Latitude),
              longitude: parseFloat(b.Longitude),
            }
          : undefined;

      return {
        from,
        to,
        body: String(b.Body || ''),
        buttonPayload: String(buttonPayload),
        isStatusCallback: false,
        // 260617-toz — inbound dedup key for the engine's Step 3.5 gate.
        providerMessageSid: b.MessageSid ? String(b.MessageSid) : undefined,
        location,
        mediaUrl: b.MediaUrl0 || undefined,
        rawFields: b,
      };
    },
  };
}

// ── Webhook Handler Wrapper (multi-sender) ───────────────────

/**
 * Wrap an engine webhook handler in an ALS sender-context frame derived from
 * `req.body.To`. The frame is set once at the boundary; every downstream
 * `provider.send*` call inherits it via AsyncLocalStorage.
 *
 * Routing rule:
 *   - req.body.To matches sandboxFromNumber  → frame { from: sandboxFromNumber, isSandbox: true }
 *   - everything else                        → frame { from: fromNumber,        isSandbox: false }
 *
 * If sandbox is unconfigured, frame.isSandbox is always false and inbound
 * traffic always routes to the prod sender.
 */
export function createTwilioWebhookHandler(
  cfg: TwilioConfig,
  innerHandle: (req: IncomingRequest) => Promise<WebhookResponse>,
): (req: IncomingRequest) => Promise<WebhookResponse> {
  const countryCode = cfg.defaultCountryCode ?? '27';
  const sandboxFrom = cfg.sandboxFromNumber
    ? normalizePhone(cfg.sandboxFromNumber, countryCode)
    : null;

  return async function wrappedHandle(req) {
    const rawTo = String(req.body?.To || '');
    const inboundTo = rawTo ? normalizePhone(rawTo, countryCode) : '';

    const isSandbox = Boolean(sandboxFrom && inboundTo === sandboxFrom);
    const frame: SenderFrame = isSandbox
      ? { from: sandboxFrom!, isSandbox: true }
      : { from: cfg.fromNumber, isSandbox: false };

    return runWithSender(frame, () => innerHandle(req));
  };
}
