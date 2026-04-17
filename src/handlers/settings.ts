import type { HandlerContext, MenuButton } from '../core/types.js';
import { sendMainMenu, withBackButton } from '../menus/main.js';

/**
 * Example: Sub-menu with stateful input collection.
 *
 * Demonstrates:
 * - Sub-menus with back navigation
 * - Collecting text input in a stateful step
 * - Persisting user preferences in state
 */

const SETTINGS_MENU: MenuButton[] = withBackButton([
  { id: 'set_language', title: '🌐 Language' },
  { id: 'set_notifications', title: '🔔 Notifications' },
]);

const LANGUAGE_MENU: MenuButton[] = withBackButton(
  [
    { id: 'lang_en', title: 'English' },
    { id: 'lang_af', title: 'Afrikaans' },
    { id: 'lang_zu', title: 'isiZulu' },
  ],
  10,
);

export async function handleSettings(
  ctx: HandlerContext,
): Promise<boolean> {
  const { status, action, phone, send } = ctx;

  // ── Show settings menu ────────────────────────────────────
  if (action === 'settings') {
    await send.sendInteractive(phone, '⚙️ *Settings*', SETTINGS_MENU);
    await ctx.setMenu(SETTINGS_MENU);
    return true;
  }

  // ── Language selection ────────────────────────────────────
  if (action === 'set_language') {
    await send.sendInteractive(
      phone,
      '🌐 *Choose your language:*',
      LANGUAGE_MENU,
    );
    await ctx.setMenu(LANGUAGE_MENU);
    return true;
  }

  if (action.startsWith('lang_')) {
    const langMap: Record<string, string> = {
      lang_en: 'English',
      lang_af: 'Afrikaans',
      lang_zu: 'isiZulu',
    };
    const langName = langMap[action] || action;
    ctx.state.preferredLanguage = action;
    await ctx.setState({ botStatus: 'idle' });
    await send.sendText(phone, `✅ Language set to *${langName}*`);
    await sendMainMenu(ctx);
    return true;
  }

  // ── Notification toggle ───────────────────────────────────
  if (action === 'set_notifications') {
    const current = ctx.state.notificationsEnabled !== false;
    ctx.state.notificationsEnabled = !current;
    await ctx.setState({ botStatus: 'idle' });
    const status = ctx.state.notificationsEnabled ? 'ON ✅' : 'OFF 🔇';
    await send.sendText(phone, `🔔 Notifications: *${status}*`);
    await sendMainMenu(ctx);
    return true;
  }

  return false;
}
