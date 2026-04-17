import type { BotConfig } from './core/types.js';
import { createTwilioAdapter } from './adapters/twilio.js';
import { createMemoryStore } from './adapters/memory-store.js';
import { handleOrderFlow } from './handlers/order.js';
import { handleFaq } from './handlers/faq.js';
import { handleSettings } from './handlers/settings.js';
import { sendMainMenu } from './menus/main.js';

/**
 * Bot configuration — the single place where everything is wired together.
 *
 * To customize for your project:
 * 1. Swap the provider adapter (Twilio, WhatsApp Cloud API, etc.)
 * 2. Swap the store adapter (memory, Prisma, Redis, etc.)
 * 3. Add your handlers to the handlers array (order matters!)
 * 4. Define your stateful statuses (for session timeout)
 * 5. Customize global commands, callbacks, and lookupUser
 */

// ── Provider ────────────────────────────────────────────────
const provider = createTwilioAdapter({
  accountSid: process.env.TWILIO_ACCOUNT_SID || '',
  apiKeySid: process.env.TWILIO_API_KEY_SID || '',
  apiKeySecret: process.env.TWILIO_API_KEY_SECRET || '',
  authToken: process.env.TWILIO_AUTH_TOKEN || '',
  fromNumber: process.env.TWILIO_WHATSAPP_FROM || '',
  webhookBaseUrl: process.env.WEBHOOK_BASE_URL,
  defaultCountryCode: '27', // Change to your country
});

// ── Store ───────────────────────────────────────────────────
const store = createMemoryStore();
// For production with DB persistence:
// import { createPrismaStore } from './adapters/prisma-store.example.js';
// const store = createPrismaStore();

// ── Config ──────────────────────────────────────────────────
export const botConfig: BotConfig = {
  provider,
  store,

  // Session timeout: reset stateful flows after 20 minutes of inactivity
  sessionTimeoutMs: 20 * 60 * 1000,

  // List ALL your stateful botStatus values here (flows that collect input).
  // "idle" should NOT be in this list — idle users don't need timeout.
  statefulStatuses: [
    'waiting_order_id',
    // Add your custom statuses as you build flows
  ],

  // Loop breaker: auto-reset after 3 identical messages in 2 minutes
  loopBreakerThreshold: 3,
  loopBreakerWindowMs: 2 * 60 * 1000,

  // Global commands — intercepted BEFORE any handler runs.
  // These work from any state (unless you add exclusion logic).
  globalCommands: [
    {
      match: ['menu', 'main menu', 'start', 'hi', 'hello'],
      handle: async (ctx) => {
        await ctx.setState({ botStatus: 'idle' });
        await sendMainMenu(ctx);
        return true;
      },
    },
    {
      match: ['reset', 'cancel'],
      handle: async (ctx) => {
        // Clear all pending flow state
        const keysToKeep = [
          'botStatus',
          'lastMenu',
          'preferredLanguage',
          'notificationsEnabled',
          '_lastUserMessage',
          '_lastUserMessageAt',
          '_lastKnownBotStatus',
          '_repeatCount',
        ];
        for (const key of Object.keys(ctx.state)) {
          if (!keysToKeep.includes(key)) {
            delete ctx.state[key];
          }
        }
        await ctx.setState({ botStatus: 'idle' });
        await ctx.send.sendText(ctx.phone, 'Session reset.');
        await sendMainMenu(ctx);
        return true;
      },
    },
    {
      match: ['help'],
      handle: async (ctx) => {
        await ctx.send.sendText(
          ctx.phone,
          '*Available commands:*\n\n' +
            '• *menu* — Main menu\n' +
            '• *reset* — Reset session\n' +
            '• *help* — This message\n\n' +
            'Or just type a number to select a menu option.',
        );
        return true;
      },
    },
  ],

  // Handler chain — ORDER MATTERS. First to return true wins.
  handlers: [
    handleOrderFlow,
    handleFaq,
    handleSettings,
    // Add your custom handlers here
  ],

  // User lookup — replace with your DB query.
  // Return null if the phone number is not registered.
  lookupUser: async (phone: string) => {
    // Example: always return a user (open bot, no registration needed)
    return { id: phone, name: 'User', phone };

    // Example with DB lookup:
    // const user = await prisma.user.findFirst({
    //   where: { OR: [{ phone }, { whatsappNumber: phone }] },
    // });
    // return user;
  },

  // Optional: derive session key from user object instead of phone
  // sessionKey: (phone, user) => String(user.id),

  // Callbacks
  onUnknownUser: async (phone, send) => {
    await send.sendText(
      phone,
      'This number is not registered. Please sign up at our website.',
    );
  },

  onFallback: async (ctx) => {
    await sendMainMenu(ctx);
  },

  onLoopBreak: async (ctx) => {
    await ctx.setState({ botStatus: 'idle' });
    await ctx.send.sendText(
      ctx.phone,
      "It looks like we're going in circles. Let me reset.",
    );
    await sendMainMenu(ctx);
  },

  onSessionTimeout: async (ctx) => {
    await ctx.setState({ botStatus: 'idle' });
    await ctx.send.sendText(
      ctx.phone,
      'Your session timed out due to inactivity. Starting fresh.',
    );
    await sendMainMenu(ctx);
  },

  // Enable debug viewer + simulator in non-production
  debug: process.env.NODE_ENV !== 'production',
};
