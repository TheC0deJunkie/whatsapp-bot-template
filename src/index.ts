import 'dotenv/config';
// Sentry init as a side-effect import, FIRST after env is loaded — see
// src/instrument.ts. Must precede the other imports so the SDK is up early.
import './instrument.js';
import express, { type Express } from 'express';
import { createWebhookHandler } from './core/engine.js';
import { botConfig } from './bot.js';
import { createTwilioWebhookHandler } from './adapters/twilio.js';
import { createMetaWebhookHandler } from './adapters/meta.js';
import { setupDebugRoutes } from './debug/viewer.js';
import { setupSimulatorRoutes } from './debug/simulator.js';
import { createCronHandler, type CronTask } from './cron-handler.js';
import { createKeepAliveHandler } from './keep-alive-handler.js';
import { prisma } from './lib/prisma.js';
import { setupSentryErrorHandler } from './lib/sentry.js';
import { debugRoutesEnabled } from './lib/env-guards.js';

// Explicit type (not inferred) so the `export default app` declaration stays
// portably nameable under pnpm's nested node_modules layout.
const app: Express = express();

// Platforms that terminate TLS at an edge forward X-Forwarded-For /
// X-Forwarded-Proto. Trusting exactly one hop makes req.ip the real client
// and req.protocol 'https' (webhook URL reconstruction) instead of the
// edge's internal address / 'http'.
app.set('trust proxy', 1);

const providerName = (process.env.WHATSAPP_PROVIDER || 'twilio').toLowerCase();
const defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE || '1';

// ── Startup Env Validation (fail-fast) ──────────────────────
// Turn a silent mis-deploy (missing required env var) into a loud cold-start
// crash with a single [startup]-tagged line naming exactly what's absent.
// The Twilio-auth check matches real usage: the send path can authenticate
// with API-key creds, so an API-key-only deployment must NOT false-fail in
// dev. In PRODUCTION the auth token is required regardless — the webhook
// signature HMAC is keyed on it.
function validateEnv(): void {
  const isProd = process.env.NODE_ENV === 'production';
  const missing: string[] = [];
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (providerName === 'twilio') {
    if (!process.env.TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
    const hasAuthToken = !!process.env.TWILIO_AUTH_TOKEN;
    const hasApiKey =
      !!process.env.TWILIO_API_KEY_SID && !!process.env.TWILIO_API_KEY_SECRET;
    if (isProd && !hasAuthToken) {
      missing.push('TWILIO_AUTH_TOKEN (required in production — webhook signature HMAC)');
    } else if (!hasAuthToken && !hasApiKey) {
      missing.push('TWILIO_AUTH_TOKEN (or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET)');
    }
  } else if (providerName === 'meta') {
    if (!process.env.META_ACCESS_TOKEN) missing.push('META_ACCESS_TOKEN');
    if (!process.env.META_PHONE_NUMBER_ID) missing.push('META_PHONE_NUMBER_ID');
    if (isProd && !process.env.META_APP_SECRET) missing.push('META_APP_SECRET');
  }
  // WEBHOOK_BASE_URL is prod-only: without it validateWebhook rebuilds the
  // signed URL from req.protocol + Host, which is attacker-influenceable
  // (Host header) and proxy-dependent — the HMAC must be computed over the
  // exact public URL the provider signed.
  if (isProd && !process.env.WEBHOOK_BASE_URL) {
    missing.push('WEBHOOK_BASE_URL');
  }
  // CRON_SECRET is prod-only — the cron handler fails closed without it, and
  // local/dev runs without cron must not be blocked from booting.
  if (isProd && !process.env.CRON_SECRET) {
    missing.push('CRON_SECRET');
  }
  if (missing.length > 0) {
    console.error(`[startup] missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}
validateEnv();

// ── Middleware ───────────────────────────────────────────────
// Capture raw body for Meta webhook signature verification using the
// body-parser `verify` callback — avoids consuming the stream twice.
const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
  (req as any).rawBody = buf.toString('utf8');
};
// Twilio sends URL-encoded bodies
app.use(express.urlencoded({ extended: false, verify: captureRawBody }));
// Simulator + Meta send JSON
app.use(express.json({ verify: captureRawBody }));

// ── Webhook Endpoint ────────────────────────────────────────
const innerHandle = createWebhookHandler(botConfig);

const handleWebhook =
  providerName === 'meta'
    ? createMetaWebhookHandler(
        {
          accessToken: process.env.META_ACCESS_TOKEN || '',
          phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
          appSecret: process.env.META_APP_SECRET || '',
          verifyToken: process.env.META_VERIFY_TOKEN || '',
          defaultCountryCode,
        },
        innerHandle,
      )
    : createTwilioWebhookHandler(
        {
          accountSid: process.env.TWILIO_ACCOUNT_SID || '',
          apiKeySid: process.env.TWILIO_API_KEY_SID || '',
          apiKeySecret: process.env.TWILIO_API_KEY_SECRET || '',
          authToken: process.env.TWILIO_AUTH_TOKEN || '',
          fromNumber: process.env.TWILIO_WHATSAPP_FROM || '',
          sandboxFromNumber: process.env.TWILIO_WHATSAPP_SANDBOX_FROM || undefined,
          sandboxJoinCode: process.env.TWILIO_SANDBOX_JOIN_CODE || undefined,
          defaultCountryCode,
        },
        innerHandle,
      );

// Meta uses GET for webhook verification; Twilio uses POST only.
app.get('/webhook', async (req, res) => {
  try {
    const result = await handleWebhook({
      method: 'GET',
      body: {},
      headers: req.headers as Record<string, string | string[] | undefined>,
      url: req.url,
      originalUrl: req.originalUrl,
      protocol: req.protocol,
      query: req.query as Record<string, string>,
    });
    res.status(result.status).send(result.body ?? '');
  } catch (err) {
    console.error('[webhook] unhandled GET error:', err);
    res.status(500).send('Internal error');
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const result = await handleWebhook({
      method: 'POST',
      body: req.body,
      headers: req.headers as Record<string, string | string[] | undefined>,
      url: req.url,
      originalUrl: req.originalUrl,
      protocol: req.protocol,
      rawBody: (req as any).rawBody,
      query: req.query as Record<string, string>,
    });
    res.status(result.status).send(result.body ?? '');
  } catch (err) {
    console.error('[webhook] unhandled error:', err);
    res.status(500).send('Internal error');
  }
});

// ── Health Check ────────────────────────────────────────────
// A green /health that never touches the DB hides database outages. /health
// runs the same SELECT 1 the keep-alive handler uses, so an unreachable DB
// surfaces as a 500 {ok:false,db:'down'} instead of a false-green 200.
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ ok: true, uptime: process.uptime(), db: 'up' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[health] db unreachable: ${message}`);
    res.status(500).json({ ok: false, db: 'down', error: message });
  }
});

// ── Keep-Alive (serverless-Postgres scale-to-zero mitigation) ─
// Point an external pinger (or a Vercel Cron) here every ~4 minutes to keep
// an auto-suspending Postgres (e.g. Neon free tier) warm. OPEN endpoint by
// design — matches /health: no data exposure, no side effects beyond a
// trivial SELECT 1 roundtrip.
app.get('/keep-alive', createKeepAliveHandler());

// ── Cron Tick Endpoint ──────────────────────────────────────
// Register your scheduled tasks here. Every task should be idempotent
// (unique DB constraints) so a double-fired tick is a no-op. Example:
//
//   const cronTasks: CronTask[] = [
//     { name: 'daily-digest', run: () => runDailyDigestScan() },
//   ];
const cronTasks: CronTask[] = [];
const cronHandler = createCronHandler(
  { secret: process.env.CRON_SECRET || '' },
  cronTasks,
);
// GET for platform crons + browser-based manual triggers; POST for symmetry.
app.get('/api/cron-tick', cronHandler);
app.post('/api/cron-tick', cronHandler);

// ── Debug Routes (explicit opt-in, never in production) ─────
// /debug/viewer + /debug/log expose every inbound/outbound message body and
// /debug/simulator drives the engine unauthenticated — mounted ONLY when
// ENABLE_DEBUG_ROUTES=true AND NODE_ENV!=='production' (env-guards.ts).
if (debugRoutesEnabled()) {
  setupDebugRoutes(app, botConfig);
  setupSimulatorRoutes(app, botConfig);
  console.log(`Debug viewer:    http://localhost:${process.env.PORT || 3000}/debug/viewer`);
  console.log(`Simulator:       http://localhost:${process.env.PORT || 3000}/debug/simulator`);
}

// ── Sentry Express error handler ────────────────────────────
// MUST come AFTER all routes so it can capture errors thrown out of any
// handler the explicit captureException() taps don't cover. No-op unless
// SENTRY_DSN is set.
setupSentryErrorHandler(app);

// ── Start Server (standalone mode) ──────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot server listening on http://localhost:${PORT}`);
  console.log(`Webhook URL:     http://localhost:${PORT}/webhook`);
});

// ── Vercel Export ───────────────────────────────────────────
export default app;
