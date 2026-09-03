// Sentry init — loaded FIRST (right after dotenv/config) in src/index.ts so the
// SDK is ready before any other app code runs and boot-time errors are captured.
// This is the bundler-friendly adaptation of Sentry's `instrument.mjs` + `--import`
// pattern: this app bundles to a single api/index.js via esbuild for Vercel
// serverless, where `node --import` doesn't apply and module-hook auto-
// instrumentation can't patch inlined modules anyway. Error capture therefore
// rides on the explicit captureException() taps + setupSentryErrorHandler()
// registered in index.ts, which work regardless of bundling. Init stays env-
// guarded (no-op unless SENTRY_DSN) and privacy-safe (sendDefaultPii:false) — see
// src/lib/sentry.ts, the sole importer of @sentry/node.
import { initSentry } from './lib/sentry.js';

initSentry();
