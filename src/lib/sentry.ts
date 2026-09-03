// ── Sentry wrapper (260617-udc) ──────────────────────────────
// The ONLY file in the codebase that imports @sentry/node. Every sink
// imports the two named functions below — never the SDK directly.
//
// Design: fully OFF by default. With SENTRY_DSN unset, initSentry() is a
// no-op (logs the disabled line once) and captureException() does nothing.
// Telemetry must NEVER throw into the request/cron path — both functions
// swallow their own errors, consistent with the house log-and-continue
// policy. The user activates it by adding SENTRY_DSN to Vercel env.
import * as Sentry from '@sentry/node';

// Module-scoped flags. `enabled` gates captureException; `initialized`
// ensures the disabled line logs at most once even across re-imports.
let enabled = false;
let initialized = false;

/**
 * Initialize Sentry from SENTRY_DSN. No-op when the DSN is unset.
 * Safe to call once at startup (right after env validation). Never throws —
 * a failed init must not crash boot.
 */
export function initSentry(): void {
  if (!process.env.SENTRY_DSN) {
    if (!initialized) {
      console.log('[sentry] disabled (no SENTRY_DSN)');
      initialized = true;
    }
    enabled = false;
    return;
  }

  try {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV ?? 'development',
      // Error tracking only for v1 — no performance tracing. Full auto-
      // instrumentation (the SDK's `--import ./instrument.mjs` path) is
      // deliberately NOT used: this app bundles to a single api/index.js via
      // esbuild for Vercel serverless, where the unbundled-preload mechanism
      // doesn't apply. Errors are captured via setupSentryErrorHandler() +
      // explicit captureException() taps, which need no preload.
      tracesSampleRate: 0,
      // PRIVACY: this app handles phone numbers and personal data. Never ship
      // user data / request bodies / IPs to Sentry. Keep PII off (this is the
      // default, set explicitly so a future edit can't silently flip it on).
      sendDefaultPii: false,
    });
    enabled = true;
    initialized = true;
    console.log('[sentry] initialized');
  } catch (err) {
    console.error('[sentry] init failed:', err);
    enabled = false;
  }
}

/**
 * Forward an error to Sentry with optional structured context. No-op when
 * Sentry is disabled. Guaranteed non-throwing — telemetry failure must never
 * break the request/cron path.
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  try {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch (e) {
    console.error('[sentry] capture failed:', e);
  }
}

/**
 * Register the Sentry Express error handler so UNHANDLED errors thrown out of
 * any route (admin API, calendar image, etc.) reach Sentry — complementing the
 * explicit captureException() taps on the webhook/cron/reminder paths. No-op
 * when Sentry is disabled. MUST be called AFTER all routes are registered.
 * Never throws — a wiring failure must not crash boot.
 */
export function setupSentryErrorHandler(app: unknown): void {
  if (!enabled) return;
  try {
    Sentry.setupExpressErrorHandler(app as never);
  } catch (e) {
    console.error('[sentry] express error handler setup failed:', e);
  }
}
