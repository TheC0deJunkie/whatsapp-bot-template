// Main menu — the idle-state hub for onboarded users.
//
// Menus are MenuButton[] rendered by the provider adapter as a numbered text
// list (*[1]* Title). ctx.setMenu(buttons) persists lastMenu so a numeric
// reply ("2") resolves back to the button id via the 5-layer action resolver.

import type { Handler, HandlerContext, MenuButton } from '../core/types.js';
import { msgMainMenuGreeting, msgHelp } from '../copy/index.js';
import { showProfileCard } from './profile.js';
import { startEchoDemo } from './echo.js';

export const MAIN_MENU: MenuButton[] = [
  { id: 'my_profile', title: '👤 My Profile' },
  { id: 'echo_demo', title: '🗣️ Echo Demo' },
  { id: 'help_info', title: '❓ Help' },
];

// Re-export the navigation-escape Set for co-location/discoverability.
// Canonical source is src/core/nav-actions.ts (pure constant, no handler
// imports → zero circular-dependency risk).
export { TOP_LEVEL_NAV_ACTIONS } from '../core/nav-actions.js';

/**
 * Push the menu to the user — used by onFallback, the `menu` command, and
 * flow endings. Also primes state.lastMenu so number replies resolve to ids.
 */
export async function sendMainMenu(ctx: HandlerContext): Promise<void> {
  await ctx.setMenu(MAIN_MENU);
  await ctx.send.sendInteractive(
    ctx.phone,
    msgMainMenuGreeting(String(ctx.user?.firstName ?? 'there')),
    MAIN_MENU,
  );
}

export const handleMainMenu: Handler = async (ctx) => {
  // Un-onboarded users belong to onboarding.
  if (!ctx.user?.firstName) return false;

  switch (ctx.action) {
    case 'my_profile':
      await showProfileCard(ctx);
      return true;
    case 'echo_demo':
      await startEchoDemo(ctx);
      return true;
    case 'help_info':
      await ctx.send.sendText(ctx.phone, msgHelp());
      return true;
    default:
      return false;
  }
};
