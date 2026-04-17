import type {
  BotConfig,
  HandlerContext,
  IncomingRequest,
  WebhookResponse,
  DurableFields,
  MenuButton,
} from './types.js';
import { resolveAction } from './action-resolver.js';
import { checkTimeout, checkLoopBreaker, updateTracking } from './session.js';
import { pushDebug } from '../debug/viewer.js';

/**
 * Create the main webhook handler from a BotConfig.
 *
 * Returns an async function that takes a normalized IncomingRequest
 * and returns { status, body }. Framework-agnostic — the Express/Vercel
 * layer is a thin wrapper in index.ts.
 *
 * Pipeline (16 steps, extracted from production):
 * 1.  Validate webhook signature
 * 2.  Parse incoming message
 * 3.  Skip status callbacks
 * 4.  Look up user
 * 5.  Handle unknown user
 * 6.  Derive session key
 * 7.  Load conversation state
 * 8.  Session timeout check
 * 9.  Loop breaker check
 * 10. Update tracking fields
 * 11. Save tracking state
 * 12. Global command interception
 * 13. Action resolution (5-layer)
 * 14. Debug push
 * 15. Handler dispatch (linear chain)
 * 16. Fallback
 */
export function createWebhookHandler(config: BotConfig) {
  return async function handleWebhook(
    req: IncomingRequest,
  ): Promise<WebhookResponse> {
    const { provider, store } = config;

    // ── Step 1: Validate webhook signature ──────────────────
    if (!provider.validateWebhook(req)) {
      return { status: 403, body: 'Invalid signature' };
    }

    // ── Step 2: Parse incoming message ──────────────────────
    const message = provider.parseWebhook(req);
    if (!message) {
      return { status: 400, body: 'Unparseable message' };
    }

    // ── Step 3: Skip status callbacks ───────────────────────
    if (message.isStatusCallback) {
      return { status: 200, body: '' };
    }

    const phone = message.from;

    // ── Step 4: Look up user ────────────────────────────────
    let user: any;
    try {
      user = await config.lookupUser(phone);
    } catch (err) {
      console.error('[bot] lookupUser error:', err);
      return { status: 500, body: 'Lookup failed' };
    }

    // ── Step 5: Handle unknown user ─────────────────────────
    if (!user) {
      if (config.onUnknownUser) {
        await config.onUnknownUser(phone, provider);
      }
      return { status: 200, body: '' };
    }

    // ── Step 6: Derive session key ──────────────────────────
    const sessionId = config.sessionKey
      ? config.sessionKey(phone, user)
      : phone;

    // ── Step 7: Load conversation state ─────────────────────
    let state: Record<string, any>;
    try {
      state = await store.get(sessionId);
    } catch (err) {
      console.error('[bot] store.get error:', err);
      state = {};
    }

    // Helper to build context (used in timeout/loop handlers too)
    const buildCtx = (action: string): HandlerContext => ({
      phone,
      message,
      state,
      action,
      text: message.body.trim(),
      textLower: message.body.trim().toLowerCase(),
      status: String(state.botStatus || 'idle'),
      user,
      send: provider,
      async setState(patch: DurableFields) {
        Object.assign(state, patch);
        await store.set(sessionId, state);
        await store.persist(sessionId, patch);
      },
      async setMenu(buttons: MenuButton[]) {
        state.lastMenu = buttons;
        await store.set(sessionId, state);
        await store.persist(sessionId, { lastMenu: buttons });
      },
    });

    // ── Step 8: Session timeout check ───────────────────────
    if (checkTimeout(state, config)) {
      const ctx = buildCtx('');
      if (config.onSessionTimeout) {
        await config.onSessionTimeout(ctx);
      } else {
        // Default: reset to idle
        state.botStatus = 'idle';
        state.lastMenu = null;
        await store.set(sessionId, state);
        await store.persist(sessionId, {
          botStatus: 'idle',
          lastMenu: null,
        });
      }
      return { status: 200, body: '' };
    }

    // ── Step 9: Loop breaker check ──────────────────────────
    if (checkLoopBreaker(state, message.body, config)) {
      const ctx = buildCtx('');
      if (config.onLoopBreak) {
        await config.onLoopBreak(ctx);
      } else {
        state.botStatus = 'idle';
        state._repeatCount = 0;
        await store.set(sessionId, state);
        await store.persist(sessionId, { botStatus: 'idle' });
      }
      return { status: 200, body: '' };
    }

    // ── Step 10: Update tracking fields ─────────────────────
    updateTracking(state, message.body);

    // ── Step 11: Save tracking state ────────────────────────
    await store.set(sessionId, state);

    const textLower = message.body.trim().toLowerCase();

    // ── Step 12: Global command interception ─────────────────
    for (const cmd of config.globalCommands) {
      let matched = false;
      if (cmd.match instanceof RegExp) {
        matched = cmd.match.test(textLower);
      } else if (Array.isArray(cmd.match)) {
        matched = cmd.match.some(
          (s) => s.toLowerCase() === textLower,
        );
      }
      if (matched) {
        const ctx = buildCtx('');
        const handled = await cmd.handle(ctx);
        if (handled) {
          await store.set(sessionId, state);
          return { status: 200, body: '' };
        }
      }
    }

    // ── Step 13: Action resolution (5-layer) ────────────────
    const action = resolveAction(message, state.lastMenu);

    // ── Step 14: Debug push ─────────────────────────────────
    if (config.debug) {
      pushDebug({
        ts: new Date().toISOString(),
        direction: 'inbound',
        from: phone,
        body: message.body,
        resolvedAction: action,
        status: String(state.botStatus || 'idle'),
        allFields: message.rawFields,
      });
    }

    // ── Step 15: Handler dispatch ───────────────────────────
    const ctx = buildCtx(action);
    for (const handler of config.handlers) {
      try {
        const handled = await handler(ctx);
        if (handled) {
          await store.set(sessionId, state);
          return { status: 200, body: '' };
        }
      } catch (err) {
        console.error('[bot] handler error:', err);
      }
    }

    // ── Step 16: Fallback ───────────────────────────────────
    if (config.onFallback) {
      await config.onFallback(ctx);
    }
    await store.set(sessionId, state);

    return { status: 200, body: '' };
  };
}
