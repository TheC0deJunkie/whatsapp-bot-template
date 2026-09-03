// ── Composition root ─────────────────────────────────────────
// The single place where providers, store, handlers, global commands and
// lifecycle callbacks are wired into a BotConfig. Swap adapters HERE, not
// in the engine or handlers.

import type { BotConfig, Handler, HandlerContext } from './core/types.js';
import { createTwilioAdapter } from './adapters/twilio.js';
import { createMetaAdapter } from './adapters/meta.js';
import { createPrismaStore } from './adapters/prisma-store.js';
import { prisma } from './lib/prisma.js';
import { normalizePhone } from './core/phone.js';
import { timezoneFromPhone } from './services/timezone.js';
import { nextStatusForBack, nextStatusForSkip } from './core/navigation.js';
import { handleOnboarding } from './handlers/onboarding.js';
import { handleMainMenu, sendMainMenu } from './handlers/main-menu.js';
import { handleProfile, showProfileCard } from './handlers/profile.js';
import { handleEcho, startEchoDemo } from './handlers/echo.js';
import {
  msgAskFullName,
  msgAskNewName,
  msgCannotSkip,
  msgHelp,
  msgLoopBreak,
  msgSessionReset,
  msgSessionTimeout,
} from './copy/index.js';
import { debugRoutesEnabled } from './lib/env-guards.js';

const defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE || '1';

// ── Provider ────────────────────────────────────────────────
// Select messaging provider via WHATSAPP_PROVIDER env var.
//   'meta'   → Meta WhatsApp Cloud API
//   'twilio' → Twilio WhatsApp (default)
const providerName = (process.env.WHATSAPP_PROVIDER || 'twilio').toLowerCase();

const provider =
  providerName === 'meta'
    ? createMetaAdapter({
        accessToken: process.env.META_ACCESS_TOKEN || '',
        phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
        appSecret: process.env.META_APP_SECRET || '',
        verifyToken: process.env.META_VERIFY_TOKEN || '',
        defaultCountryCode,
      })
    : createTwilioAdapter({
        accountSid: process.env.TWILIO_ACCOUNT_SID || '',
        apiKeySid: process.env.TWILIO_API_KEY_SID || '',
        apiKeySecret: process.env.TWILIO_API_KEY_SECRET || '',
        authToken: process.env.TWILIO_AUTH_TOKEN || '',
        fromNumber: process.env.TWILIO_WHATSAPP_FROM || '',
        sandboxFromNumber: process.env.TWILIO_WHATSAPP_SANDBOX_FROM || undefined,
        sandboxJoinCode: process.env.TWILIO_SANDBOX_JOIN_CODE || undefined,
        webhookBaseUrl: process.env.WEBHOOK_BASE_URL,
        defaultCountryCode,
      });

console.log(`[bot] provider: ${providerName}`);

// ── Store ───────────────────────────────────────────────────
const store = createPrismaStore();

// ── Provider auth (Twilio Content API) ──────────────────────
// Surfaced to handlers via ctx.providerAuth so they can call
// getContentTemplate(name, auth) at runtime to status-branch between
// sendContentTemplate (approved) and a free-form fallback.
// Null when env vars are absent → handlers fall back unconditionally.
const providerAuth =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? {
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
      }
    : null;

// ── back/skip re-render dispatch ────────────────────────────
// Maps a BACK_MAP target status back to its interactive-surface re-render fn.
// Called AFTER setState so the user lands on the surface they're returning to
// (never a silent status flip). Statuses with no dedicated re-render fn fall
// through to `default` — state is already set; the next inbound message
// re-prompts via the handler chain.
async function rerenderForStatus(
  ctx: HandlerContext,
  status: string,
): Promise<void> {
  switch (status) {
    case 'awaiting_firstName':
      await ctx.send.sendText(ctx.phone, msgAskFullName());
      return;
    case 'awaiting_profile_menu':
      await showProfileCard(ctx);
      return;
    case 'awaiting_edit_firstName':
      await ctx.send.sendText(ctx.phone, msgAskNewName());
      return;
    case 'awaiting_echo_text':
      await startEchoDemo(ctx);
      return;
    default:
      return;
  }
}

// Shared "where does BACK go when there is no main menu?" resolver.
// Un-onboarded users have nothing to land on, so re-ask the name instead.
async function backToMainMenuOrOnboarding(ctx: HandlerContext): Promise<void> {
  if (!ctx.user?.firstName) {
    await ctx.setState({ botStatus: 'awaiting_firstName' });
    await ctx.send.sendText(ctx.phone, msgAskFullName());
    return;
  }
  await ctx.setState({ botStatus: 'idle' });
  await sendMainMenu(ctx);
}

// ── Universal nav handler ───────────────────────────────────
// A TAPPED [← Back][🏠 Menu] button resolves to an ACTION (nav_back /
// nav_menu), NOT text — so it can't trigger the text-matched global back/menu
// commands. This handler mirrors those commands for the action path. It runs
// FIRST in the chain and returns false for everything else, so status-specific
// handlers still own their own buttons.
export const handleNav: Handler = async (ctx) => {
  if (ctx.action === 'main_menu' || ctx.action === 'nav_menu') {
    // Defensive: only onboarded users get menus; otherwise fall through to
    // onboarding rather than render a blank menu.
    if (!ctx.user?.firstName) return false;
    await ctx.setState({ botStatus: 'idle' });
    await sendMainMenu(ctx);
    return true;
  }
  if (ctx.action === 'nav_back') {
    const target = nextStatusForBack(ctx.status);
    if (!target || target === 'main_menu') {
      await backToMainMenuOrOnboarding(ctx);
      return true;
    }
    await ctx.setState({ botStatus: target });
    await rerenderForStatus(ctx, target);
    return true;
  }
  return false;
};

// ── Config ──────────────────────────────────────────────────
export const botConfig: BotConfig = {
  provider,
  store,
  providerAuth,

  sessionTimeoutMs: 20 * 60 * 1000,

  // Flows that collect input — subject to session-timeout reset.
  // INVARIANT: every awaiting_* status a handler can set belongs here, and
  // should have a BACK_MAP entry (or a deliberate omission) in
  // src/core/navigation.ts.
  statefulStatuses: [
    'awaiting_firstName',
    'awaiting_profile_menu',
    'awaiting_edit_firstName',
    'awaiting_echo_text',
  ],

  loopBreakerThreshold: 3,
  loopBreakerWindowMs: 2 * 60 * 1000,

  // Note: "hi"/"hello" are deliberately NOT menu triggers. On first contact
  // those messages must reach handleOnboarding so new users hit the welcome
  // flow. Fully-onboarded users land on the main menu via onFallback.
  globalCommands: [
    {
      match: ['menu', 'main menu'],
      handle: async (ctx) => {
        if (!ctx.user?.firstName) {
          // There is no main menu pre-onboarding — re-ask the name instead of
          // answering "menu" with silence or a blank menu.
          await ctx.setState({ botStatus: 'awaiting_firstName' });
          await ctx.send.sendText(ctx.phone, msgAskFullName());
          return true;
        }
        await ctx.setState({ botStatus: 'idle' });
        await sendMainMenu(ctx);
        return true;
      },
    },
    {
      match: ['reset', 'cancel'],
      handle: async (ctx) => {
        const keysToKeep = [
          'botStatus',
          'lastMenu',
          '_lastUserMessage',
          '_lastUserMessageAt',
          '_lastKnownBotStatus',
          '_repeatCount',
        ];
        for (const key of Object.keys(ctx.state)) {
          if (!keysToKeep.includes(key)) delete ctx.state[key];
        }
        await ctx.setState({
          botStatus: 'idle',
          draftFirstName: null,
          draftSurname: null,
        });
        await ctx.send.sendText(ctx.phone, msgSessionReset());
        return true;
      },
    },
    {
      match: ['help'],
      handle: async (ctx) => {
        await ctx.send.sendText(ctx.phone, msgHelp());
        return true;
      },
    },
    // `back` — routes one step up the current flow via BACK_MAP. Never
    // silently fails: a mapped status re-renders its parent surface; an
    // unmapped/main_menu target drops the user to the main menu.
    {
      match: ['back'],
      handle: async (ctx) => {
        const target = nextStatusForBack(ctx.status);
        if (!target || target === 'main_menu') {
          await backToMainMenuOrOnboarding(ctx);
          return true;
        }
        await ctx.setState({ botStatus: target });
        await rerenderForStatus(ctx, target);
        return true;
      },
    },
    // `skip` — advances past optional steps per SKIP_MAP. Unmapped (required)
    // steps refuse via msgCannotSkip. Always returns true.
    {
      match: ['skip'],
      handle: async (ctx) => {
        const target = nextStatusForSkip(ctx.status);
        if (!target) {
          await ctx.send.sendText(ctx.phone, msgCannotSkip());
          return true;
        }
        if (target === 'idle') {
          await ctx.setState({ botStatus: 'idle' });
          await sendMainMenu(ctx);
          return true;
        }
        await ctx.setState({ botStatus: target });
        await rerenderForStatus(ctx, target);
        return true;
      },
    },
  ],

  // Handler chain — order matters. handleNav first so universal Back/Menu
  // button taps resolve before any status-gated handler.
  handlers: [
    handleNav,
    handleOnboarding,
    handleProfile,
    handleEcho,
    handleMainMenu,
  ],

  // Upsert on first contact. phone is already normalized E.164 by the
  // provider adapter, so it's safe to use as both identity and session key.
  // A timezone is inferred from the phone's calling code at creation so
  // scheduled sends compute on the user's local day; never overwrite a
  // timezone the user later picks.
  lookupUser: async (phone: string) => {
    const user = await prisma.user.upsert({
      where: { phone },
      update: {},
      create: { phone, timezone: timezoneFromPhone(phone) },
    });
    return user;
  },

  // Session key = normalized E.164. Independent of user.id so unknown
  // users (if you ever add gating) still have their own session slot.
  sessionKey: (phone) => normalizePhone(phone, defaultCountryCode),

  onFallback: async (ctx) => {
    // Onboarded users who said something unrecognized land on the menu.
    if (ctx.user?.firstName) {
      await sendMainMenu(ctx);
      return;
    }
    // Un-onboarded users must never get silence: the engine trims the inbound
    // body, so a whitespace-only reply arrives as text === '' and the
    // onboarding handler declines the turn. Re-render the step they are on.
    // Media-only inbound is deliberately excluded — an image with no caption
    // is not a fumbled text reply, and force-re-prompting it would nag.
    if (ctx.text === '' && !ctx.message.mediaUrl) {
      await rerenderForStatus(ctx, ctx.status);
    }
  },

  onLoopBreak: async (ctx) => {
    await ctx.setState({ botStatus: 'idle' });
    await ctx.send.sendText(ctx.phone, msgLoopBreak());
  },

  onSessionTimeout: async (ctx) => {
    await ctx.setState({
      botStatus: 'idle',
      draftFirstName: null,
      draftSurname: null,
    });
    await ctx.send.sendText(ctx.phone, msgSessionTimeout());
  },

  // Engine debug-log push is only useful when the /debug viewer is mounted —
  // same explicit ENABLE_DEBUG_ROUTES=true + non-production gate.
  debug: debugRoutesEnabled(),
};
