// Table-driven back/skip navigation for multi-step flows.
//
// Consumed by src/bot.ts globalCommands. Map keys are botStatus strings;
// values are the destination botStatus (or the sentinel 'main_menu' when
// back should drop the user out of the flow entirely).
//
// INVARIANT: every status in BotConfig.statefulStatuses (src/bot.ts) should
// either have an entry here OR be deliberately omitted. When adding a new
// awaiting_* status to a handler, add it to BACK_MAP here too.

export type BackTarget = string | 'main_menu';

export const BACK_MAP: Readonly<Record<string, BackTarget>> = Object.freeze({
  // Onboarding — the name ask is the very first thing a new number sees,
  // so there is nothing behind it.
  awaiting_firstName: 'main_menu',

  // Profile: card → main menu; name edit → back to the card.
  awaiting_profile_menu: 'main_menu',
  awaiting_edit_firstName: 'awaiting_profile_menu',

  // Echo demo — single-step flow, back exits entirely.
  awaiting_echo_text: 'main_menu',
});

// SKIP_MAP is deliberately small — only steps where the underlying field can
// be null/absent without breaking downstream invariants belong here.
// Anything not in SKIP_MAP refuses with msgCannotSkip — the step is required.
export const SKIP_MAP: Readonly<Record<string, string>> = Object.freeze({
  awaiting_echo_text: 'idle',
});

/** Returns the target status for `back` from currentStatus, or null when unmapped. */
export function nextStatusForBack(currentStatus: string): BackTarget | null {
  return BACK_MAP[currentStatus] ?? null;
}

/** Returns the target status for `skip` from currentStatus, or null when not skippable. */
export function nextStatusForSkip(currentStatus: string): string | null {
  return SKIP_MAP[currentStatus] ?? null;
}
