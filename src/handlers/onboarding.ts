// Onboarding — first contact → capture full name → main menu.
//
// Pattern notes (apply to every handler in the chain):
//   - Handlers return Promise<boolean>; true stops the chain.
//   - Early-return false unless this handler owns the current turn — either
//     the user's botStatus is one of ours, or the user is in the state we
//     bootstrap from (here: not yet onboarded).
//   - Empty text on an owned status returns false so BotConfig.onFallback can
//     re-render the step prompt (whitespace-only replies must never go silent).

import type { Handler } from '../core/types.js';
import { prisma } from '../lib/prisma.js';
import { msgWelcome, msgOnboardingDone } from '../copy/index.js';
import { splitFullName } from '../services/name.js';
import { sendMainMenu } from './main-menu.js';

export const handleOnboarding: Handler = async (ctx) => {
  const { status, text, user } = ctx;
  const onboarded = !!user?.firstName;

  // Fully-onboarded users are not ours — let the menu handlers run.
  if (onboarded && status !== 'awaiting_firstName') return false;

  // First contact (any message from a user with no profile): welcome + ask.
  if (!onboarded && status !== 'awaiting_firstName') {
    await ctx.setState({ botStatus: 'awaiting_firstName' });
    await ctx.send.sendText(ctx.phone, msgWelcome());
    return true;
  }

  // awaiting_firstName — capture the name.
  if (status === 'awaiting_firstName') {
    if (!text) return false; // whitespace-only → onFallback re-prompts
    const { firstName, surname } = splitFullName(text);
    if (!firstName) return false;
    await prisma.user.update({
      where: { id: user.id },
      data: { firstName, surname },
    });
    // Mutate the in-memory user too so downstream sends greet correctly.
    user.firstName = firstName;
    user.surname = surname;
    await ctx.setState({
      botStatus: 'idle',
      draftFirstName: null,
      draftSurname: null,
    });
    await ctx.send.sendText(ctx.phone, msgOnboardingDone(firstName));
    await sendMainMenu(ctx);
    return true;
  }

  return false;
};
