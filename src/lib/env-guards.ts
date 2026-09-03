// Explicit opt-in gates for dev-only behaviour that used to hinge on
// NODE_ENV alone. A missing/misspelt NODE_ENV on a real deployment (a
// preview env, a self-hosted box, a container without the var) must fail SAFE:
// webhook signatures still validated, debug UIs not mounted. Both gates
// therefore require the explicit `=== 'true'` flag AND a non-production
// NODE_ENV — either one alone is not enough.
//
// Read at call time (not module import) — Vercel cold-start env resolution
// can lag module evaluation (D-10 / pitfall #6 elsewhere in this codebase).

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Skip Twilio/Meta webhook signature validation. Dev simulator needs this. */
export function webhookValidationSkipped(): boolean {
  return process.env.TWILIO_SKIP_WEBHOOK_VALIDATION === 'true' && !isProduction();
}

/** Mount /debug/viewer, /debug/log and /debug/simulator. */
export function debugRoutesEnabled(): boolean {
  return process.env.ENABLE_DEBUG_ROUTES === 'true' && !isProduction();
}
