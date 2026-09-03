// Main-menu + global-command copy.

export const msgMainMenuGreeting = (firstName: string): string =>
  `What would you like to do, ${firstName}?`;

export const msgHelp = (): string =>
  '*Commands:*\n' +
  '• *menu* — Main menu\n' +
  '• *back* — One step back\n' +
  '• *skip* — Skip an optional step\n' +
  '• *reset* — Start over\n' +
  '• *help* — This message';

// Refusal for `skip` on a required step. Always name the escape hatches —
// a refusal with no way out is a dead end.
export const msgCannotSkip = (): string =>
  "I need this one — it can't be skipped. (Type *back* to go back, or *menu* to start over.)";

export const msgSessionReset = (): string => 'Session reset.';

export const msgLoopBreak = (): string =>
  "It looks like we're going in circles. Let me reset.";

export const msgSessionTimeout = (): string =>
  'Your session timed out. Say *hi* when you want to continue.';
