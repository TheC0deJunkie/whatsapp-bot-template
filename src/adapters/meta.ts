import crypto from 'crypto';
import type {
  ProviderAdapter,
  IncomingRequest,
  IncomingMessage,
  MessageResult,
  MenuButton,
  WebhookResponse,
} from '../core/types.js';
import { normalizePhone } from '../core/phone.js';
import { safeEqual } from '../lib/safe-equal.js';
import { isProduction, webhookValidationSkipped } from '../lib/env-guards.js';

// ── Configuration ─────────────────────────────────────────────

export interface MetaConfig {
  /** Permanent access token from Meta App Dashboard */
  accessToken: string;
  /** WhatsApp Business Phone Number ID (numeric string) */
  phoneNumberId: string;
  /** App secret for webhook signature verification */
  appSecret: string;
  /** Verify token set in the Meta webhook config panel */
  verifyToken: string;
  /** Default country code for phone normalization (default: '27') */
  defaultCountryCode?: string;
  /** Skip webhook signature validation. Default derives from the explicit
   *  TWILIO_SKIP_WEBHOOK_VALIDATION=true opt-in (env-guards.ts). Even when
   *  set to true here, validation is NEVER skipped under NODE_ENV=production. */
  skipValidationInDev?: boolean;
}

// ── Adapter Factory ───────────────────────────────────────────

export function createMetaAdapter(cfg: MetaConfig): ProviderAdapter {
  const apiBase = `https://graph.facebook.com/v20.0/${cfg.phoneNumberId}`;
  const countryCode = cfg.defaultCountryCode ?? '27';

  // Mirrors twilio.ts — explicit opt-in AND non-production, resolved per call,
  // warned once per process.
  let warnedSkip = false;
  function shouldSkipValidation(): boolean {
    const skip =
      cfg.skipValidationInDev === undefined
        ? webhookValidationSkipped()
        : cfg.skipValidationInDev && !isProduction();
    if (skip && !warnedSkip) {
      warnedSkip = true;
      console.warn(
        '[meta] WARNING: webhook signature validation is DISABLED ' +
          '(TWILIO_SKIP_WEBHOOK_VALIDATION=true / skipValidationInDev). Dev only.',
      );
    }
    return skip;
  }

  // ── Internal send helper ──────────────────────────────────
  async function metaSend(payload: Record<string, unknown>, method: string): Promise<MessageResult> {
    try {
      const res = await fetch(`${apiBase}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
      });

      const json = await res.json() as any;

      if (!res.ok) {
        console.error(`[meta] send error (${method}):`, json);
        return { ok: false, error: json.error?.message || `HTTP ${res.status}` };
      }

      const msgId = json.messages?.[0]?.id;
      return { ok: true, sid: msgId };
    } catch (err: any) {
      console.error(`[meta] fetch error (${method}):`, err);
      return { ok: false, error: err.message };
    }
  }

  // ── Provider Adapter Implementation ───────────────────────
  // 260528-hxb — sendTemplate is extracted into a local ref so
  // sendContentTemplate (the new ProviderAdapter method) can delegate
  // without relying on `this` resolution inside the returned object literal.
  const sendTemplateImpl = async (
    to: string,
    templateName: string,
    variables?: Record<string, string>,
  ): Promise<MessageResult> => {
    const normalized = normalizePhone(to, countryCode);
    const components = variables && Object.keys(variables).length > 0
      ? [
          {
            type: 'body',
            parameters: Object.values(variables).map((v) => ({
              type: 'text',
              text: v,
            })),
          },
        ]
      : undefined;

    const templatePayload: Record<string, unknown> = {
      name: templateName,
      language: { code: 'en' },
    };
    if (components) templatePayload.components = components;

    return metaSend(
      {
        to: normalized,
        type: 'template',
        template: templatePayload,
      },
      'sendTemplate',
    );
  };

  return {
    async sendText(to: string, text: string): Promise<MessageResult> {
      const normalized = normalizePhone(to, countryCode);
      return metaSend(
        {
          to: normalized,
          type: 'text',
          text: { body: text },
        },
        'sendText',
      );
    },

    async sendInteractive(
      to: string,
      bodyText: string,
      buttons: MenuButton[],
    ): Promise<MessageResult> {
      const normalized = normalizePhone(to, countryCode);
      // Render as numbered text list (mirrors Twilio approach — no native
      // interactive buttons needed; numeric reply resolver handles mapping).
      const capped = buttons.slice(0, 10);
      const lines = capped.map((b, i) => `*[${i + 1}]* ${b.title}`);
      const full = bodyText
        ? `${bodyText}\n\n${lines.join('\n')}`
        : lines.join('\n');

      return metaSend(
        {
          to: normalized,
          type: 'text',
          text: { body: full },
        },
        'sendInteractive',
      );
    },

    async sendMedia(
      to: string,
      text: string,
      mediaUrl: string,
    ): Promise<MessageResult> {
      const normalized = normalizePhone(to, countryCode);
      // Send image with caption; falls back to link in text for non-image media.
      return metaSend(
        {
          to: normalized,
          type: 'image',
          image: { link: mediaUrl, caption: text },
        },
        'sendMedia',
      );
    },

    async sendTemplate(
      to: string,
      templateName: string,
      variables?: Record<string, string>,
    ): Promise<MessageResult> {
      return sendTemplateImpl(to, templateName, variables);
    },

    // 260528-hxb — Meta has no Content API SID concept; the WhatsApp Cloud
    // API addresses templates by NAME, not by SID. We delegate to
    // sendTemplate so the ProviderAdapter type contract is satisfied without
    // changing behaviour. Phase 2 only ships under WHATSAPP_PROVIDER=twilio
    // so this code path is unreachable in prod — the stub guards the type
    // surface only.
    async sendContentTemplate(
      to: string,
      contentSid: string,
      contentVariables?: Record<string, string>,
    ): Promise<MessageResult> {
      return sendTemplateImpl(to, contentSid, contentVariables);
    },

    validateWebhook(req: IncomingRequest): boolean {
      if (shouldSkipValidation()) return true;

      // Meta sends GET for verification challenge — always pass validation
      // because the challenge handler lives in the route, not here.
      if (req.method === 'GET') return true;

      const signature = req.headers['x-hub-signature-256'];
      if (!signature || typeof signature !== 'string') return false;

      const rawBody =
        typeof req.rawBody === 'string'
          ? req.rawBody
          : JSON.stringify(req.body || {});

      const expected =
        'sha256=' +
        crypto
          .createHmac('sha256', cfg.appSecret)
          .update(rawBody)
          .digest('hex');

      // Length-guarded — raw timingSafeEqual throws on a short/garbage header,
      // which would turn a probe into a 500 instead of a clean reject.
      return safeEqual(signature, expected);
    },

    parseWebhook(req: IncomingRequest): IncomingMessage | null {
      const b = req.body as any;

      // Meta webhook envelope
      if (b?.object !== 'whatsapp_business_account') return null;

      const changes = b?.entry?.[0]?.changes?.[0]?.value;
      if (!changes) return null;

      // Status callbacks (delivery receipts etc.) — no message to process
      if (changes.statuses && !changes.messages) {
        return {
          from: '',
          body: '',
          buttonPayload: '',
          isStatusCallback: true,
        };
      }

      const msg = changes.messages?.[0];
      if (!msg) return null;

      const rawFrom = String(msg.from || '');
      if (!rawFrom) return null;

      const from = normalizePhone(rawFrom, countryCode);

      let body = '';
      let buttonPayload = '';
      let mediaUrl: string | undefined;
      let location: { latitude: number; longitude: number } | undefined;

      if (msg.type === 'text') {
        body = String(msg.text?.body || '');
      } else if (msg.type === 'interactive') {
        const interactive = msg.interactive;
        if (interactive?.type === 'button_reply') {
          buttonPayload = interactive.button_reply?.id || '';
          body = interactive.button_reply?.title || '';
        } else if (interactive?.type === 'list_reply') {
          buttonPayload = interactive.list_reply?.id || '';
          body = interactive.list_reply?.title || '';
        }
      } else if (msg.type === 'image' || msg.type === 'video' || msg.type === 'document') {
        const media = msg[msg.type];
        // Media URL requires a separate Graph API call in production;
        // for now surface the media ID so handlers can detect media messages.
        mediaUrl = media?.id ? `https://graph.facebook.com/v20.0/${media.id}` : undefined;
        body = media?.caption || '';
      } else if (msg.type === 'location') {
        location = {
          latitude: msg.location?.latitude,
          longitude: msg.location?.longitude,
        };
      }

      return {
        from,
        body,
        buttonPayload,
        isStatusCallback: false,
        location,
        mediaUrl,
        rawFields: msg,
      };
    },
  };
}

// ── Webhook Handler Wrapper (verify + parse) ──────────────────

/**
 * Wrap the engine webhook handler for Meta Cloud API webhooks.
 *
 * - GET  /webhook  → responds to Meta's hub.challenge verification handshake
 * - POST /webhook  → processes inbound messages
 *
 * Raw body capture is handled by the Express `express.json()` middleware;
 * pass `req.rawBody` for signature verification (requires a rawBody capture
 * middleware — see index.ts).
 */
export function createMetaWebhookHandler(
  cfg: MetaConfig,
  innerHandle: (req: IncomingRequest) => Promise<WebhookResponse>,
): (req: IncomingRequest) => Promise<WebhookResponse> {
  return async function wrappedHandle(req) {
    // Meta verification challenge (GET)
    if (req.method === 'GET') {
      const params = req.query as Record<string, string>;
      const mode = params['hub.mode'];
      const token = params['hub.verify_token'];
      const challenge = params['hub.challenge'];
      // Never log the expected verify token — it is a shared secret. A bare
      // match flag is enough to debug a mis-pasted panel value.
      const tokenOk = !!cfg.verifyToken && safeEqual(String(token ?? ''), cfg.verifyToken);
      console.log('[meta] webhook GET — mode:', mode, '| verify-token match:', tokenOk);
      if (mode === 'subscribe' && tokenOk) {
        console.log('[meta] webhook verified ✓ — returning challenge:', challenge);
        return { status: 200, body: challenge };
      }
      console.warn('[meta] webhook verification FAILED — token mismatch or wrong mode');
      return { status: 403, body: 'Forbidden' };
    }

    return innerHandle(req);
  };
}
