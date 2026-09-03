// Onboarding copy. The template's onboarding is a single step (full name) —
// extend with more steps (and matching awaiting_* statuses) as your bot needs.
//
// Convention: every user-facing string lives in src/copy/, exported as a
// msg<Thing> function, so wording is reviewable in one place.

export const msgWelcome = (): string =>
  "Hi! 👋 Welcome. Let's get you set up.\n\nWhat's your *full name*? (first and last)";

// Bare re-ask — used by onFallback / `back` when the user is mid-onboarding.
export const msgAskFullName = (): string =>
  "What's your *full name*? (first and last)";

export const msgOnboardingDone = (firstName: string): string =>
  `All set, ${firstName}. 🎉 You're ready to go.`;
