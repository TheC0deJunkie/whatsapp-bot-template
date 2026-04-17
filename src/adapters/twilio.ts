import crypto from 'crypto';
import type {
  ProviderAdapter,
  IncomingRequest,
  IncomingMessage,
  MessageResult,
  MenuButton,
} from '../core/types.js';
import { normalizePhone, stripWhatsAppPrefix } from '../core/phone.js';

// ── Configuration ─────────────────────────────────────────────

export interface TwilioConfig {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  authToken: string;
  fromNumber: string;
  /** Base URL for webhook validation (e.g. https://your-domain.com) */
  webhookBaseUrl?: string;
  /** Default country code for phone normalization (default: '27') */
  defaultCountryCode?: string;
  /** Skip webhook validation in non-production (default: true if NODE_ENV !== 'production') */
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
  const countryCode = cfg.defaultCountryCode ?? '27';
  const skipInDev =
    cfg.skipValidationInDev ?? process.env.NODE_ENV !== 'production';

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

    const body = new URLSearchParams({
      To: toWa,
      From: fromWa,
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

    async sendTemplate(
      to: string,
      contentSid: string,
      variables?: Record<string, string>,
    ): Promise<MessageResult> {
      const params: Record<string, string> = {
        ContentSid: contentSid,
      };
      if (cfg.fromNumber) {
        // Templates may need MessagingServiceSid instead of From
        params.MessagingServiceSid = cfg.accountSid;
      }
      if (variables) {
        params.ContentVariables = JSON.stringify(variables);
      }
      return twilioSend(to, params, 'sendTemplate');
    },

    validateWebhook(req: IncomingRequest): boolean {
      if (skipInDev) return true;

      const signature = req.headers['x-twilio-signature'];
      if (!signature || typeof signature !== 'string') return false;

      // Reconstruct the full URL
      const protocol = req.protocol || 'https';
      const url =
        cfg.webhookBaseUrl && req.originalUrl
          ? `${cfg.webhookBaseUrl}${req.originalUrl}`
          : `${protocol}://${req.headers.host}${req.originalUrl || req.url || '/'}`;

      // Sort body params and append to URL
      const body = req.body || {};
      const paramString = Object.keys(body)
        .sort()
        .reduce((acc, key) => acc + key + body[key], '');

      const expected = crypto
        .createHmac('sha1', cfg.authToken)
        .update(url + paramString)
        .digest('base64');

      return signature === expected;
    },

    parseWebhook(req: IncomingRequest): IncomingMessage | null {
      const b = req.body || {};

      // Status callback check
      if (b.SmsStatus && !b.Body && !b.ButtonPayload) {
        return {
          from: '',
          body: '',
          buttonPayload: '',
          isStatusCallback: true,
        };
      }

      const rawFrom = String(b.From || '');
      if (!rawFrom) return null;

      const from = normalizePhone(rawFrom, countryCode);

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
        body: String(b.Body || ''),
        buttonPayload: String(buttonPayload),
        isStatusCallback: false,
        location,
        mediaUrl: b.MediaUrl0 || undefined,
        rawFields: b,
      };
    },
  };
}
