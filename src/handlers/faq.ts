import type { HandlerContext } from '../core/types.js';
import { sendMainMenu, withBackButton } from '../menus/main.js';

/**
 * Example: Stateless handler with sub-menu.
 *
 * Demonstrates:
 * - Responding to a menu action without changing botStatus
 * - Showing a sub-menu with numbered options
 * - Handling sub-menu selections
 * - Back navigation
 */

const FAQ_MENU = withBackButton([
  { id: 'faq_shipping', title: '🚚 Shipping Info' },
  { id: 'faq_returns', title: '↩️ Return Policy' },
  { id: 'faq_contact', title: '📞 Contact Us' },
]);

const FAQ_ANSWERS: Record<string, string> = {
  faq_shipping:
    '*Shipping Information*\n\n' +
    '• Standard: 3-5 business days\n' +
    '• Express: 1-2 business days\n' +
    '• Free shipping on orders over R500\n\n' +
    'Track your order by selecting *Order Status* from the main menu.',

  faq_returns:
    '*Return Policy*\n\n' +
    '• 30-day return window\n' +
    '• Item must be unused and in original packaging\n' +
    '• Refund processed within 5-7 business days\n\n' +
    'To start a return, email returns@example.com with your order ID.',

  faq_contact:
    '*Contact Us*\n\n' +
    '📧 support@example.com\n' +
    '📞 0800 123 4567 (Mon-Fri 8am-5pm)\n' +
    '🌐 www.example.com/help',
};

export async function handleFaq(ctx: HandlerContext): Promise<boolean> {
  const { action, phone, send } = ctx;

  // Show FAQ menu
  if (action === 'faq') {
    await send.sendInteractive(phone, '❓ *Frequently Asked Questions*\n\nSelect a topic:', FAQ_MENU);
    await ctx.setMenu(FAQ_MENU);
    return true;
  }

  // Handle FAQ sub-options
  if (action in FAQ_ANSWERS) {
    await send.sendText(phone, FAQ_ANSWERS[action]);
    await send.sendInteractive(phone, 'Need anything else?', FAQ_MENU);
    await ctx.setMenu(FAQ_MENU);
    return true;
  }

  return false;
}
