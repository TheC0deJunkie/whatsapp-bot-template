import type { HandlerContext, MenuButton } from '../core/types.js';

/**
 * Main menu definition.
 * Replace these with your own domain-specific menu items.
 * Button IDs map to actions in your handlers.
 */

export const MAIN_MENU: MenuButton[] = [
  { id: 'order_status', title: '📦 Order Status' },
  { id: 'faq', title: '❓ FAQ' },
  { id: 'settings', title: '⚙️ Settings' },
];

export async function sendMainMenu(ctx: HandlerContext): Promise<void> {
  const name = ctx.user?.name || 'there';
  await ctx.send.sendInteractive(
    ctx.phone,
    `Hi ${name}! How can I help you today?`,
    MAIN_MENU,
  );
  await ctx.setMenu(MAIN_MENU);
}

/**
 * Helper: append navigation buttons to any sub-menu.
 * Keeps total buttons under the WhatsApp limit.
 */
export function withBackButton(
  buttons: MenuButton[],
  maxButtons = 10,
): MenuButton[] {
  const nav: MenuButton[] = [{ id: 'main_menu', title: '↩ Back to Menu' }];
  const available = maxButtons - nav.length;
  return [...buttons.slice(0, available), ...nav];
}
