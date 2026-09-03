// ── Navigation escape constants ──────────────────────────────────────────────
// Pure constant — no handler imports. engine.ts imports from here to avoid any
// circular dependency risk (engine → handler → engine).
//
// These are the action ids that ALWAYS escape sticky capture statuses when
// delivered as native button/list-row taps (engine Step 13.5). Covers every
// MAIN_MENU id — the parity test in engine.test.ts asserts this Set always
// contains every MAIN_MENU id so the two never drift.
//
// Flow-internal ids (edit_name, etc.) are deliberately excluded — those must
// keep being handled inside their own flow handlers.

export const TOP_LEVEL_NAV_ACTIONS = new Set([
  'my_profile',
  'echo_demo',
  'help_info',
]);
