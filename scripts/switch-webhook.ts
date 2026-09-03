import 'dotenv/config';

// ─────────────────────────────────────────────────────────────────────────────
// Operator script — flips the Twilio WhatsApp sender's primary + fallback
// webhook URLs between local devtunnel testing and production. One command,
// deterministic, logs BEFORE/AFTER so the operator can visually confirm.
//
// Usage:
//   tsx scripts/switch-webhook.ts local   → primary=${WEBHOOK_BASE_URL}/webhook, fallback=PROD
//   tsx scripts/switch-webhook.ts prod    → primary=PROD, fallback=PROD
//
// 260815 — BOTH targets also pin the sender's status_callback_url to PROD
// /api/twilio-status. Delivery failures (63016/63028/63051…) only reach us via
// this callback; without it a queued-then-failed reminder is never retried
// (nine days of prod reminders were lost that way). It always points at prod —
// the callback flips prod DB rows, and a devtunnel would silently swallow them.
// ─────────────────────────────────────────────────────────────────────────────

const PROD_BASE = (process.env.PROD_BASE_URL || '').replace(/\/+$/, '');
if (!PROD_BASE) {
  console.error('[switch-webhook] PROD_BASE_URL env var is required (e.g. https://your-app.vercel.app)');
  process.exit(1);
}
const PROD_WEBHOOK = `${PROD_BASE}/webhook`;
const PROD_STATUS_CALLBACK = `${PROD_BASE}/api/twilio-status`;
const LOG_TAG = '[switch-webhook]';

// ── Twilio API response shapes (minimal — only what we read) ────────────────
interface SenderWebhook {
  callback_url?: string;
  callback_method?: string;
  fallback_url?: string;
  fallback_method?: string;
  status_callback_url?: string;
  status_callback_method?: string;
}

interface Sender {
  sid: string;
  sender_id: string;
  webhook?: SenderWebhook;
}

interface ListSendersResponse {
  senders?: Sender[];
}

interface UpdateSenderResponse {
  webhook?: SenderWebhook;
}

// ── Exported helpers (named exports only, per repo convention) ──────────────

export function buildAuthHeader(accountSid: string, authToken: string): string {
  return 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
}

export async function listSenders(auth: string): Promise<Sender[]> {
  const res = await fetch('https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp', {
    method: 'GET',
    headers: { Authorization: auth },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twilio list senders failed: ${res.status} ${res.statusText} — ${body}`);
  }
  const data = (await res.json()) as ListSendersResponse;
  return data.senders ?? [];
}

export async function updateSenderWebhook(
  auth: string,
  senderSid: string,
  primary: string,
  fallback: string,
  statusCallback: string = PROD_STATUS_CALLBACK,
): Promise<{ callback_url: string; fallback_url: string; status_callback_url: string }> {
  const res = await fetch(`https://messaging.twilio.com/v2/Channels/Senders/${senderSid}`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      webhook: {
        callback_url: primary,
        callback_method: 'POST',
        fallback_url: fallback,
        fallback_method: 'POST',
        status_callback_url: statusCallback,
        status_callback_method: 'POST',
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twilio update sender failed: ${res.status} ${res.statusText} — ${body}`);
  }
  const data = (await res.json()) as UpdateSenderResponse;
  return {
    callback_url: data.webhook?.callback_url ?? '',
    fallback_url: data.webhook?.fallback_url ?? '',
    status_callback_url: data.webhook?.status_callback_url ?? '',
  };
}

// ── Main runner (module-private) ────────────────────────────────────────────

async function run(): Promise<void> {
  // 1. CLI target validation
  const target = process.argv[2];
  if (target !== 'local' && target !== 'prod') {
    console.error(`${LOG_TAG} usage: tsx scripts/switch-webhook.ts <local|prod>`);
    process.exit(1);
  }

  // 2. Env validation (core Twilio creds + sender phone)
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_WHATSAPP_FROM;
  if (!accountSid || !authToken || !fromNumber) {
    console.error(
      `${LOG_TAG} missing required env: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM`
    );
    process.exit(1);
  }

  // 3. local-only WEBHOOK_BASE_URL check
  const webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
  if (target === 'local' && !webhookBaseUrl) {
    console.error(
      `${LOG_TAG} WEBHOOK_BASE_URL is required for target=local (set it to your devtunnel URL in .env)`
    );
    process.exit(1);
  }

  // 4. Compute target URLs
  const primary = target === 'local' ? `${webhookBaseUrl}/webhook` : PROD_WEBHOOK;
  const fallback = PROD_WEBHOOK;

  // 5. Build auth header
  const auth = buildAuthHeader(accountSid, authToken);

  console.log(`${LOG_TAG} target=${target} — looking up sender for whatsapp:${fromNumber}`);

  // 6. List senders + match
  const senders = await listSenders(auth);
  const sender = senders.find((s) => s.sender_id === `whatsapp:${fromNumber}`);
  if (!sender) {
    console.error(`${LOG_TAG} no WhatsApp sender found for whatsapp:${fromNumber}`);
    process.exit(1);
  }

  // 7. BEFORE logging
  console.log(`${LOG_TAG} sender sid=${sender.sid}`);
  console.log(`${LOG_TAG} BEFORE primary=${sender.webhook?.callback_url ?? '(none)'}`);
  console.log(`${LOG_TAG} BEFORE fallback=${sender.webhook?.fallback_url ?? '(none)'}`);
  console.log(`${LOG_TAG} BEFORE status_callback=${sender.webhook?.status_callback_url || '(none)'}`);

  // 8. POST update — status callback is always PROD (see header comment).
  const updated = await updateSenderWebhook(auth, sender.sid, primary, fallback, PROD_STATUS_CALLBACK);

  // 9. AFTER logging (using Twilio-echoed values)
  console.log(`${LOG_TAG} AFTER  primary=${updated.callback_url}`);
  console.log(`${LOG_TAG} AFTER  fallback=${updated.fallback_url}`);
  console.log(`${LOG_TAG} AFTER  status_callback=${updated.status_callback_url || '(none)'}`);
  if (updated.status_callback_url !== PROD_STATUS_CALLBACK) {
    console.warn(
      `${LOG_TAG} WARNING: Twilio echoed status_callback_url="${updated.status_callback_url}" ` +
        `(expected ${PROD_STATUS_CALLBACK}) — delivery failures will NOT be reconciled until this is set`,
    );
  }
  console.log(`${LOG_TAG} done — target=${target}`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG_TAG} failed:`, err);
    process.exit(1);
  });
