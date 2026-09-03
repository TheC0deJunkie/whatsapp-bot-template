import type {
  BotConfig,
  HandlerContext,
  IncomingRequest,
  WebhookResponse,
  DurableFields,
  MenuButton,
} from "./types.js";
import { resolveAction } from "./action-resolver.js";
import { checkTimeout, checkLoopBreaker, updateTracking } from "./session.js";
import { pushDebug } from "../debug/viewer.js";
import { TOP_LEVEL_NAV_ACTIONS } from "./nav-actions.js";
import { logMessage } from "../services/message-log.js";
import { upsertDeliveryStatus } from "../services/delivery-log.js";
import { msgHandlerError, msgStateLoadFailed } from "../copy/index.js";
import { prisma } from "../lib/prisma.js";
import { captureException } from "../lib/sentry.js";

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
 * 8.  Update tracking fields
 * 9.  Session timeout check
 * 10. Loop breaker check
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
      return { status: 403, body: "Invalid signature" };
    }

    // ── Step 2: Parse incoming message ──────────────────────
    const message = provider.parseWebhook(req);
    if (!message) {
      return { status: 400, body: "Unparseable message" };
    }

    // ── Step 3: Delivery status callbacks ───────────────────
    // 260616-glb — upsert the MessageDelivery row by SID (fire-and-forget,
    // never blocks/500s) then return 200. We only upsert when we have both a
    // SID and a status — a callback without a SID can't be correlated, so we
    // don't create an orphan row.
    if (message.isStatusCallback) {
      if (message.statusCallbackSid && message.statusCallbackStatus) {
        upsertDeliveryStatus({
          sid: message.statusCallbackSid,
          status: message.statusCallbackStatus,
          errorCode: message.statusCallbackErrorCode,
          errorMessage: message.statusCallbackErrorMessage,
        });
      }
      return { status: 200, body: "" };
    }

    const phone = message.from;

    // ── Step 3.5: Inbound dedup gate (260617-toz) ───────────
    // Twilio can redeliver the same inbound webhook (network retries). Insert
    // the MessageSid before processing: a P2002 unique-violation means we've
    // already handled this exact delivery → skip so session state isn't
    // re-mutated. FAIL-OPEN on any other DB error — a dedup-table outage must
    // never drop a real message. No SID (simulator/test paths) → skip the gate.
    if (message.providerMessageSid) {
      const sid = message.providerMessageSid;
      try {
        await prisma.inboundDedup.create({ data: { messageSid: sid } });
      } catch (err: any) {
        if (err?.code === "P2002") {
          console.log(`[bot] duplicate inbound MessageSid, skipping: ${sid}`);
          return { status: 200, body: "" };
        }
        // Any other error → log and fall through (fail-open).
        console.error("[bot] inbound dedup insert error (continuing):", err);
      }
    }

    // ── Step 4: Look up user ────────────────────────────────
    // feat-prisma-retry-lookupuser — retry transient DB errors (Neon cold-start /
    // connection blips) up to 3 attempts with a short backoff. Non-transient
    // errors (e.g. a real query/schema fault) fail fast after one attempt — no
    // point retrying a deterministic failure. After exhaustion we preserve the
    // existing { status: 500, body: 'Lookup failed' } shape.
    let user: any;
    try {
      user = await lookupUserWithRetry(config, phone);
    } catch (err) {
      console.error("[bot] lookupUser error:", err);
      captureException(err, { phone, where: 'lookupUser' });
      return { status: 500, body: "Lookup failed" };
    }

    // ── Step 5: Handle unknown user ─────────────────────────
    if (!user) {
      if (config.onUnknownUser) {
        await config.onUnknownUser(phone, provider);
      }
      return { status: 200, body: "" };
    }

    // ── Step 6: Derive session key ──────────────────────────
    const sessionId = config.sessionKey
      ? config.sessionKey(phone, user)
      : phone;

    // ── Step 7: Load conversation state ─────────────────────
    // debug-260902 ROOT CAUSE A. This used to be `catch { state = {} }`, which
    // converted an INFRASTRUCTURE error into a SEMANTIC one: an empty state
    // reads back as botStatus 'idle', every status-gated handler declines the
    // turn, and Step 16 answers a mid-flow user with the main menu. A user who
    // had just been asked "Who are you adding, and when?" typed a name + date
    // and got the menu greeting — their add silently discarded, no error shown.
    //
    // Never fabricate state. Retry transient DB errors the same way Step 4
    // retries lookupUser, and if the load still fails, tell the user plainly
    // and leave the durable row untouched so their next message resumes the
    // flow intact. Returning 200 (not 500) is deliberate: Step 3.5 already
    // burned this MessageSid in inboundDedup, so a Twilio retry would be
    // dropped as a duplicate — a 500 here would mean total silence.
    let state: Record<string, any>;
    try {
      state = await loadStateWithRetry(store, sessionId);
    } catch (err) {
      console.error("[bot] store.get error (state NOT fabricated):", err);
      captureException(err, { phone, where: "store.get" });
      try {
        await provider.sendText(phone, msgStateLoadFailed());
      } catch (sendErr) {
        console.error("[bot] state-load error notice failed:", sendErr);
      }
      return { status: 200, body: "" };
    }

    // Helper to build context (used in timeout/loop handlers too)
    const buildCtx = (action: string): HandlerContext => ({
      phone,
      message,
      state,
      action,
      text: message.body.trim(),
      textLower: message.body.trim().toLowerCase(),
      status: String(state.botStatus || "idle"),
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
      // 260528-hxb — Twilio Content API credentials surfaced to handlers for
      // runtime template lookup via getContentTemplate. Sourced from
      // BotConfig.providerAuth (built once at boot from process.env in
      // src/bot.ts). Null when env vars are absent → handlers fall back to
      // free-form sends.
      providerAuth: config.providerAuth ?? null,
    });

    // ── Step 9: Session timeout check ───────────────────────
    if (checkTimeout(state, config)) {
      const ctx = buildCtx("");
      if (config.onSessionTimeout) {
        await config.onSessionTimeout(ctx);
      } else {
        // Default: reset to idle
        state.botStatus = "idle";
        state.lastMenu = null;
        await store.set(sessionId, state);
        await store.persist(sessionId, {
          botStatus: "idle",
          lastMenu: null,
        });
      }
    }

    // ── Step 10: Loop breaker check ──────────────────────────
    if (checkLoopBreaker(state, message.body, config)) {
      const ctx = buildCtx("");
      if (config.onLoopBreak) {
        await config.onLoopBreak(ctx);
      } else {
        state.botStatus = "idle";
        state._repeatCount = 0;
        await store.set(sessionId, state);
        await store.persist(sessionId, { botStatus: "idle" });
      }
      return { status: 200, body: "" };
    }

    // ── Step 11: Update tracking and save state ────────────────
    // Update tracking fields AFTER timeout/loop checks so they compare
    // against the PREVIOUS turn's state. 260423-sto: handlers still see
    // the new timestamp because we persist here before dispatch.
    updateTracking(state, message.body);

    // debug-260429 Bug E Option 1 — capture the durable per-recipient sender
    // (which Twilio number the user texted) so the reminder cron can later
    // pin its outbound `From` to it. message.to is populated by parseWebhook
    // from req.body.To; null for non-Twilio providers / status callbacks.
    if (message.to) {
      state.lastSenderFrom = message.to;
    }

    // Persist _lastUserMessageAt + lastSenderFrom to the durable store so the
    // reminder worker (and session-timeout logic after cold starts) can read
    // them. Only write lastSenderFrom when present — otherwise leave the
    // existing column value alone.
    //
    // debug-260903 (S5) — guarded. A Neon blip here used to escape as an
    // unhandled rejection → HTTP 500 → Twilio retry → Step 3.5's InboundDedup
    // row swallowed the retry as a duplicate → the user's message vanished.
    // `state` is already fully mutated in memory by updateTracking + the
    // message.to assignment above, so losing the durable write costs us only
    // the tracking timestamp — never the turn. Log and continue to Step 12.
    try {
      await store.set(sessionId, state);
      const persistFields: any = {
        _lastUserMessageAt: state._lastUserMessageAt,
      };
      if (message.to) {
        persistFields.lastSenderFrom = message.to;
      }
      await store.persist(sessionId, persistFields);
    } catch (err) {
      console.error("[bot] Step 11 tracking persist error (continuing):", err);
      captureException(err, { phone, where: "step11-persist" });
    }

    const textLower = message.body.trim().toLowerCase();

    // ── Step 12: Global command interception ─────────────────
    for (const cmd of config.globalCommands) {
      let matched = false;
      if (cmd.match instanceof RegExp) {
        matched = cmd.match.test(textLower);
      } else if (Array.isArray(cmd.match)) {
        matched = cmd.match.some((s) => s.toLowerCase() === textLower);
      }
      if (matched) {
        // debug-260903 (S6) — guarded, mirroring Step 15's handler-dispatch
        // catch below. A throwing global command (menu/reset/help/back/skip)
        // used to escape as a 500 with no reply at all; the user saw silence
        // and Twilio's retry was eaten by the Step 3.5 dedup row. Same policy
        // as a throwing handler: one graceful fallback, then end the turn.
        try {
          const ctx = buildCtx("");
          const handled = await cmd.handle(ctx);
          if (handled) {
            await store.set(sessionId, state);
            return { status: 200, body: "" };
          }
        } catch (err) {
          console.error("[bot] global command error:", err);
          captureException(err, { phone, where: "global-command-dispatch" });
          // The fallback send is itself guarded — a provider failure must not
          // escalate the original error into an unhandled 500.
          try {
            await provider.sendText(phone, msgHandlerError());
          } catch (sendErr) {
            console.error(
              "[bot] global command error fallback send failed:",
              sendErr,
            );
          }
          await store.set(sessionId, state);
          return { status: 200, body: "" };
        }
      }
    }

    // ── Step 13: Action resolution (5-layer) ────────────────
    const action = resolveAction(message, state.lastMenu);

    // ── Step 13.5: Button-tap navigation escape ─────────────
    // 260608-gti — A native button/list-row tap (buttonPayload is non-empty)
    // targeting a top-level main-menu action MUST always navigate — it must
    // not be consumed by a status-gated capture handler (e.g. handleWishlistPrune
    // eating any input while awaiting_prune_reply is active). Free-text input
    // (buttonPayload='') is intentionally excluded so capture flows still accept
    // typed responses. Mutates state in-place like the loop-break/timeout paths.
    if (message.buttonPayload?.trim() && TOP_LEVEL_NAV_ACTIONS.has(action)) {
      // The in-memory flip is what the handler chain below actually reads, so
      // it stays outside the guard — it cannot throw.
      state.botStatus = "idle";
      // debug-260903 (S5) — same log-and-continue policy as Step 11: a durable
      // write failure here must not 500 the turn. Worst case the escape isn't
      // durable across a cold start; the tap still navigates on this turn.
      try {
        await store.set(sessionId, state);
        await store.persist(sessionId, { botStatus: "idle" });
      } catch (err) {
        console.error(
          "[bot] Step 13.5 nav-escape persist error (continuing):",
          err,
        );
        captureException(err, { phone, where: "step13.5-persist" });
      }
    }

    // ── Step 14: Debug push ─────────────────────────────────
    if (config.debug) {
      pushDebug({
        ts: new Date().toISOString(),
        direction: "inbound",
        from: phone,
        body: message.body,
        resolvedAction: action,
        status: String(state.botStatus || "idle"),
        allFields: message.rawFields,
      });
    }

    // 260610-o06 — Persist inbound message to the Message log. Fire-and-forget:
    // logMessage swallows DB errors internally; never blocks this path.
    logMessage({
      phone,
      userId: user?.id ?? null,
      direction: "inbound",
      body: message.body,
    });

    // ── Step 15: Handler dispatch ───────────────────────────
    const ctx = buildCtx(action);
    for (const handler of config.handlers) {
      try {
        const handled = await handler(ctx);
        if (handled) {
          await store.set(sessionId, state);
          return { status: 200, body: "" };
        }
      } catch (err) {
        console.error("[bot] handler error:", err);
        captureException(err, { phone, where: 'handler-dispatch' });
        // 260617-0js fix #3 — a throwing handler used to leave the user in
        // silence (the catch only logged, then the next handler ran or the
        // request fell through to a silent 200). Send one graceful fallback
        // and end the chain so the message fires at most once per request.
        // The send is itself guarded — log-and-continue is the house policy,
        // so a provider failure can't escalate into an unhandled 500.
        try {
          await provider.sendText(phone, msgHandlerError());
        } catch (sendErr) {
          console.error("[bot] handler error fallback send failed:", sendErr);
        }
        await store.set(sessionId, state);
        return { status: 200, body: "" };
      }
    }

    // ── Step 16: Fallback ───────────────────────────────────
    if (config.onFallback) {
      await config.onFallback(ctx);
      await store.set(sessionId, state);
      return { status: 200, body: "" };
    }

    await store.set(sessionId, state);
    return { status: 200, body: "" };
  };
}

// ── lookupUser retry helper ───────────────────────────────────────────────────
// feat-prisma-retry-lookupuser — Neon serverless Postgres can throw a transient
// PrismaClientInitializationError ("the database server could not be reached")
// on cold-start or a brief connection blip. Those are worth retrying; a
// deterministic error (bad column, etc.) is not. We attempt up to 3 times for
// transient errors only, with a short awaited backoff between tries so the test
// suite (real timers) stays fast. The final throw is re-raised to the caller,
// which logs and returns { status: 500, body: 'Lookup failed' }.

const LOOKUP_MAX_ATTEMPTS = 3;
const LOOKUP_BACKOFF_MS = 10;

// debug-260902 — the same retry discipline for the session-state read. Step 7
// used to swallow this error entirely; now a transient Neon blip is retried and
// a hard failure PROPAGATES so the caller can tell the user instead of silently
// demoting a mid-flow user to 'idle'.
async function loadStateWithRetry(
  store: BotConfig["store"],
  sessionId: string,
): Promise<Record<string, any>> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= LOOKUP_MAX_ATTEMPTS; attempt++) {
    try {
      return await store.get(sessionId);
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || attempt === LOOKUP_MAX_ATTEMPTS) {
        throw err;
      }
      console.warn(
        `[bot] store.get transient error, retrying (attempt ${attempt}/${LOOKUP_MAX_ATTEMPTS}):`,
        err,
      );
      await new Promise((r) => setTimeout(r, LOOKUP_BACKOFF_MS * attempt));
    }
  }
  throw lastErr;
}

function isTransientDbError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (!e) return false;
  if (e.name === "PrismaClientInitializationError") return true;
  return /could not be reached|connection|timed out|ECONNREFUSED|ETIMEDOUT/i.test(
    e.message ?? "",
  );
}

async function lookupUserWithRetry(
  config: BotConfig,
  phone: string,
): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= LOOKUP_MAX_ATTEMPTS; attempt++) {
    try {
      return await config.lookupUser(phone);
    } catch (err) {
      lastErr = err;
      // Fail fast on non-transient errors, or once attempts are exhausted.
      if (!isTransientDbError(err) || attempt === LOOKUP_MAX_ATTEMPTS) {
        throw err;
      }
      console.warn(
        `[bot] lookupUser transient error, retrying (attempt ${attempt}/${LOOKUP_MAX_ATTEMPTS}):`,
        err,
      );
      await new Promise((r) => setTimeout(r, LOOKUP_BACKOFF_MS * attempt));
    }
  }
  // Unreachable — the loop either returns or throws — but satisfies the compiler.
  throw lastErr;
}
