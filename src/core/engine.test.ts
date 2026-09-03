// debug-260429 Bug E Option 1 — engine inbound persist hook for lastSenderFrom.
//
// The reminder cron has no inbound webhook → no ALS sender frame is set on
// the stack → twilioSend defaults to prod sender. To pin the right `From`
// per recipient at cron time, we persist the inbound `To` (Twilio sender the
// user texted) on every webhook turn. This test locks the persist contract:
//
//   When parseWebhook produces an IncomingMessage with `to: <e164>`,
//   the engine MUST call store.persist with `lastSenderFrom: <e164>` on
//   the same upsert that writes _lastUserMessageAt.
//
// Coverage targets:
//   - Sandbox-paired user → persist lastSenderFrom='+14155238886'.
//   - Prod-paired user    → persist lastSenderFrom='+15550009999'.
//   - parseWebhook returns no `to` (e.g. status callback) → persist still
//     runs for _lastUserMessageAt but does NOT write lastSenderFrom (avoids
//     blanking a previously-persisted value).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWebhookHandler } from './engine.js';
import type { BotConfig, ProviderAdapter, IncomingMessage } from './types.js';
import { TOP_LEVEL_NAV_ACTIONS } from './nav-actions.js';
import { MAIN_MENU } from '../handlers/main-menu.js';

// 260616-glb — stub the delivery-log so the engine's status-callback upsert
// can be asserted without touching Prisma.
vi.mock('../services/delivery-log.js', () => ({
  upsertDeliveryStatus: vi.fn(),
  seedDelivery: vi.fn(),
}));
import { upsertDeliveryStatus } from '../services/delivery-log.js';

// 260617-toz — stub the prisma singleton so the engine's Step 3.5 inbound
// dedup gate can be exercised without touching a real Postgres connection.
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    inboundDedup: { create: vi.fn() },
    // logMessage (fire-and-forget) writes to prisma.message on the processing
    // path — stub it so the dedup tests don't hit a real connection.
    message: { create: vi.fn().mockResolvedValue({}) },
  },
}));
import { prisma } from '../lib/prisma.js';

function makeProvider(parsed: IncomingMessage | null): ProviderAdapter {
  return {
    sendText: vi.fn().mockResolvedValue({ ok: true }),
    sendInteractive: vi.fn().mockResolvedValue({ ok: true }),
    sendMedia: vi.fn().mockResolvedValue({ ok: true }),
    sendTemplate: vi.fn().mockResolvedValue({ ok: true }),
    // 260528-hxb — ProviderAdapter interface extended with Twilio Content
    // API send. Stub satisfies the type contract for this test fixture.
    sendContentTemplate: vi.fn().mockResolvedValue({ ok: true }),
    validateWebhook: vi.fn().mockReturnValue(true),
    parseWebhook: vi.fn().mockReturnValue(parsed),
  };
}

interface CapturedStore {
  persistCalls: Array<{ sessionId: string; fields: Record<string, any> }>;
  setCalls: Array<{ sessionId: string; state: Record<string, any> }>;
}

function makeStore(): { store: any; captured: CapturedStore } {
  const captured: CapturedStore = { persistCalls: [], setCalls: [] };
  const memory = new Map<string, Record<string, any>>();
  const store = {
    async get(sessionId: string) {
      return memory.get(sessionId) ?? {};
    },
    async set(sessionId: string, state: Record<string, any>) {
      memory.set(sessionId, state);
      captured.setCalls.push({ sessionId, state: { ...state } });
    },
    async clear(sessionId: string) {
      memory.delete(sessionId);
    },
    async persist(sessionId: string, fields: Record<string, any>) {
      captured.persistCalls.push({ sessionId, fields: { ...fields } });
    },
  };
  return { store, captured };
}

function makeConfig(provider: ProviderAdapter, store: any): BotConfig {
  return {
    provider,
    store,
    statefulStatuses: [],
    globalCommands: [],
    handlers: [],
    lookupUser: vi.fn().mockResolvedValue({ id: 'u1', phone: '+27821234567' }),
  };
}

describe('engine — inbound persist of lastSenderFrom (Bug E Option 1)', () => {
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('persists lastSenderFrom from message.to when user texts the sandbox sender', async () => {
    const provider = makeProvider({
      from: '+27821234567',
      to: '+14155238886', // sandbox sender
      body: 'menu',
      buttonPayload: '',
      isStatusCallback: false,
    });
    const { store, captured } = makeStore();
    const handler = createWebhookHandler(makeConfig(provider, store));

    const res = await handler({ body: {}, headers: {} });

    expect(res.status).toBe(200);
    // Find the persist call that ships lastSenderFrom; by design it's the one
    // alongside _lastUserMessageAt.
    const persistWithSender = captured.persistCalls.find(
      (c) => 'lastSenderFrom' in c.fields,
    );
    expect(persistWithSender).toBeDefined();
    expect(persistWithSender!.fields.lastSenderFrom).toBe('+14155238886');
    expect(persistWithSender!.sessionId).toBe('+27821234567');
    // _lastUserMessageAt rides on the same upsert.
    expect(persistWithSender!.fields._lastUserMessageAt).toBeTypeOf('number');
  });

  it('persists lastSenderFrom from message.to when user texts the prod sender', async () => {
    const provider = makeProvider({
      from: '+27821234567',
      to: '+15550009999', // prod sender
      body: 'menu',
      buttonPayload: '',
      isStatusCallback: false,
    });
    const { store, captured } = makeStore();
    const handler = createWebhookHandler(makeConfig(provider, store));

    await handler({ body: {}, headers: {} });

    const persistWithSender = captured.persistCalls.find(
      (c) => 'lastSenderFrom' in c.fields,
    );
    expect(persistWithSender).toBeDefined();
    expect(persistWithSender!.fields.lastSenderFrom).toBe('+15550009999');
  });

  it('does NOT write lastSenderFrom when message.to is absent (preserves prior value)', async () => {
    const provider = makeProvider({
      from: '+27821234567',
      // no `to` field — non-Twilio provider or status callback that fell
      // through the early-return guard
      body: 'menu',
      buttonPayload: '',
      isStatusCallback: false,
    });
    const { store, captured } = makeStore();
    const handler = createWebhookHandler(makeConfig(provider, store));

    await handler({ body: {}, headers: {} });

    // Persist still runs to record _lastUserMessageAt — but lastSenderFrom
    // must be omitted so prisma-store's upsert leaves the column untouched.
    const persistWithSender = captured.persistCalls.find(
      (c) => 'lastSenderFrom' in c.fields,
    );
    expect(persistWithSender).toBeUndefined();
    // _lastUserMessageAt persist still happens.
    const persistWithTimestamp = captured.persistCalls.find(
      (c) => '_lastUserMessageAt' in c.fields,
    );
    expect(persistWithTimestamp).toBeDefined();
  });

  it('skips status callbacks entirely — no persist call', async () => {
    const provider = makeProvider({
      from: '',
      body: '',
      buttonPayload: '',
      isStatusCallback: true,
    });
    const { store, captured } = makeStore();
    const handler = createWebhookHandler(makeConfig(provider, store));

    const res = await handler({ body: {}, headers: {} });

    expect(res.status).toBe(200);
    expect(captured.persistCalls).toHaveLength(0);
  });
});

describe('engine — lookupUser retry-with-backoff (feat-prisma-retry-lookupuser)', () => {
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  function transientError(): Error {
    const err = new Error('the database server could not be reached');
    err.name = 'PrismaClientInitializationError';
    return err;
  }

  function makeMessage(): IncomingMessage {
    return {
      from: '+27821234567',
      to: '+15550009999',
      body: 'menu',
      buttonPayload: '',
      isStatusCallback: false,
    };
  }

  it('retries past two transient DB errors and returns the user on the third try', async () => {
    const provider = makeProvider(makeMessage());
    const { store } = makeStore();
    const config = makeConfig(provider, store);
    const lookupUser = vi
      .fn()
      .mockRejectedValueOnce(transientError())
      .mockRejectedValueOnce(transientError())
      .mockResolvedValue({ id: 'u1', phone: '+27821234567' });
    config.lookupUser = lookupUser;
    const handler = createWebhookHandler(config);

    const res = await handler({ body: {}, headers: {} });

    expect(lookupUser).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(200);
    expect(res.body).not.toBe('Lookup failed');
  });

  it('returns 500 "Lookup failed" when all three attempts throw transient errors', async () => {
    const provider = makeProvider(makeMessage());
    const { store } = makeStore();
    const config = makeConfig(provider, store);
    const lookupUser = vi.fn().mockRejectedValue(transientError());
    config.lookupUser = lookupUser;
    const handler = createWebhookHandler(config);

    const res = await handler({ body: {}, headers: {} });

    expect(lookupUser).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(500);
    expect(res.body).toBe('Lookup failed');
  });

  it('does not retry a non-transient error — fails fast after one attempt', async () => {
    const provider = makeProvider(makeMessage());
    const { store } = makeStore();
    const config = makeConfig(provider, store);
    const lookupUser = vi
      .fn()
      .mockRejectedValue(new Error('column does not exist'));
    config.lookupUser = lookupUser;
    const handler = createWebhookHandler(config);

    const res = await handler({ body: {}, headers: {} });

    expect(lookupUser).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expect(res.body).toBe('Lookup failed');
  });
});

// ── 260608-gti: button-tap navigation escape ──────────────────────────────────
// A native button/list-row tap (buttonPayload non-empty) targeting a top-level
// main-menu action MUST escape any sticky capture status (awaiting_capture_a,
// awaiting_capture_b, …) so handleMainMenu can route it. Free-text input
// (buttonPayload='') must NOT escape — capture flows still accept typed replies.
describe('engine — button-tap navigation escape (260608-gti)', () => {
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // A handler that owns a sticky capture status: returns true (chain stops)
  // ONLY while ctx.status matches its status. Mirrors handleWishlistPrune /
  // handleWishlistCapture / handleCircles status-gated early-return pattern.
  function captureHandler(status: string) {
    return vi.fn(async (ctx: any) => {
      if (ctx.status === status) return true;
      return false;
    });
  }

  // A stand-in for handleMainMenu: handles top-level nav actions only when the
  // session is idle (so it never fires while a capture handler still owns the
  // turn). Returns true when it routes.
  function mainMenuHandler() {
    return vi.fn(async (ctx: any) => {
      if (ctx.status === 'idle' && TOP_LEVEL_NAV_ACTIONS.has(ctx.action)) {
        return true;
      }
      return false;
    });
  }

  function makeStatefulConfig(
    provider: ProviderAdapter,
    store: any,
    handlers: any[],
  ): BotConfig {
    return {
      provider,
      store,
      statefulStatuses: [
        'awaiting_capture_a',
        'awaiting_capture_b',
        'awaiting_capture_c',
      ],
      globalCommands: [],
      handlers,
      lookupUser: vi.fn().mockResolvedValue({ id: 'u1', phone: '+27821234567' }),
    };
  }

  async function seedStatus(store: any, sessionId: string, botStatus: string) {
    // Pre-seed the in-memory store with the stuck status so the session
    // starts in the capture state.
    await store.set(sessionId, { botStatus });
  }

  it('A: stuck in awaiting_capture_a + button tap my_profile → escapes to main-menu route', async () => {
    const provider = makeProvider({
      from: '+27821234567',
      to: '+15550009999',
      body: '👤 My Profile',
      buttonPayload: 'my_profile',
      isStatusCallback: false,
    });
    const { store } = makeStore();
    await seedStatus(store, '+27821234567', 'awaiting_capture_a');
    const prune = captureHandler('awaiting_capture_a');
    const main = mainMenuHandler();
    const handler = createWebhookHandler(
      makeStatefulConfig(provider, store, [prune, main]),
    );

    const res = await handler({ body: {}, headers: {} });

    expect(res.status).toBe(200);
    // Capture handler saw idle (escaped) → did NOT stop the chain.
    expect(prune).toHaveReturnedWith(Promise.resolve(false));
    expect(prune.mock.calls[0][0].status).toBe('idle');
    // Main-menu handler routed the tap.
    expect(main).toHaveBeenCalled();
    expect(main.mock.calls[0][0].action).toBe('my_profile');
  });

  it('B: stuck in awaiting_capture_b + button tap echo_demo → capture handler falls through', async () => {
    const provider = makeProvider({
      from: '+27821234567',
      to: '+15550009999',
      body: '🗣️ Echo Demo',
      buttonPayload: 'echo_demo',
      isStatusCallback: false,
    });
    const { store } = makeStore();
    await seedStatus(store, '+27821234567', 'awaiting_capture_b');
    const capture = captureHandler('awaiting_capture_b');
    const main = mainMenuHandler();
    const handler = createWebhookHandler(
      makeStatefulConfig(provider, store, [capture, main]),
    );

    await handler({ body: {}, headers: {} });

    expect(capture.mock.calls[0][0].status).toBe('idle');
    expect(main).toHaveBeenCalled();
    expect(main.mock.calls[0][0].action).toBe('echo_demo');
  });

  it('C: free TEXT while in awaiting_capture_a (buttonPayload empty) → NOT escaped, prune handles it', async () => {
    const provider = makeProvider({
      from: '+27821234567',
      to: '+15550009999',
      body: 'add a new ps5 game to my list',
      buttonPayload: '',
      isStatusCallback: false,
    });
    const { store } = makeStore();
    await seedStatus(store, '+27821234567', 'awaiting_capture_a');
    const prune = captureHandler('awaiting_capture_a');
    const main = mainMenuHandler();
    const handler = createWebhookHandler(
      makeStatefulConfig(provider, store, [prune, main]),
    );

    await handler({ body: {}, headers: {} });

    // Status NOT reset → prune handler still owns the turn.
    expect(prune.mock.calls[0][0].status).toBe('awaiting_capture_a');
    expect(prune).toHaveReturnedWith(Promise.resolve(true));
    expect(main).not.toHaveBeenCalled();
  });

  it('D: flow-internal button tap manage_people while in awaiting_capture_c → NOT escaped', async () => {
    const provider = makeProvider({
      from: '+27821234567',
      to: '+15550009999',
      body: '👥 Manage people',
      buttonPayload: 'manage_people',
      isStatusCallback: false,
    });
    const { store } = makeStore();
    await seedStatus(store, '+27821234567', 'awaiting_capture_c');
    const circles = captureHandler('awaiting_capture_c');
    const main = mainMenuHandler();
    const handler = createWebhookHandler(
      makeStatefulConfig(provider, store, [circles, main]),
    );

    await handler({ body: {}, headers: {} });

    // manage_people is NOT in TOP_LEVEL_NAV_ACTIONS → status preserved.
    expect(circles.mock.calls[0][0].status).toBe('awaiting_capture_c');
    expect(main).not.toHaveBeenCalled();
  });

  it('D2: stuck in awaiting_capture_a + button tap manage_people → status NOT reset (guards future Set drift)', async () => {
    const provider = makeProvider({
      from: '+27821234567',
      to: '+15550009999',
      body: '👥 Manage people',
      buttonPayload: 'manage_people',
      isStatusCallback: false,
    });
    const { store } = makeStore();
    await seedStatus(store, '+27821234567', 'awaiting_capture_a');
    const prune = captureHandler('awaiting_capture_a');
    const main = mainMenuHandler();
    const handler = createWebhookHandler(
      makeStatefulConfig(provider, store, [prune, main]),
    );

    await handler({ body: {}, headers: {} });

    // manage_people is flow-internal → not intercepted even when status is sticky.
    expect(prune.mock.calls[0][0].status).toBe('awaiting_capture_a');
    expect(prune).toHaveReturnedWith(Promise.resolve(true));
    expect(main).not.toHaveBeenCalled();
  });

  it('E: empty buttonPayload with a top-level action body → NOT intercepted (gate needs non-empty payload)', async () => {
    // body is the literal title but no native ListId/ButtonPayload — e.g. the
    // user typed the menu label as free text. resolveAction may still map it,
    // but the escape gate requires a non-empty buttonPayload.
    const provider = makeProvider({
      from: '+27821234567',
      to: '+15550009999',
      body: 'my_profile',
      buttonPayload: '',
      isStatusCallback: false,
    });
    const { store } = makeStore();
    await seedStatus(store, '+27821234567', 'awaiting_capture_a');
    const prune = captureHandler('awaiting_capture_a');
    const main = mainMenuHandler();
    const handler = createWebhookHandler(
      makeStatefulConfig(provider, store, [prune, main]),
    );

    await handler({ body: {}, headers: {} });

    // No native tap → no escape → prune still owns the turn.
    expect(prune.mock.calls[0][0].status).toBe('awaiting_capture_a');
    expect(main).not.toHaveBeenCalled();
  });

  it('F (parity): TOP_LEVEL_NAV_ACTIONS contains every MAIN_MENU id', () => {
    for (const btn of MAIN_MENU) {
      expect(TOP_LEVEL_NAV_ACTIONS.has(btn.id)).toBe(true);
    }
  });
});

// 260616-glb — status-callback delivery upsert wiring.
describe('engine — status callback upserts delivery', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (upsertDeliveryStatus as ReturnType<typeof vi.fn>).mockClear();
  });

  it('upserts delivery when callback carries sid + status', async () => {
    const provider = makeProvider({
      from: '',
      body: '',
      buttonPayload: '',
      isStatusCallback: true,
      statusCallbackSid: 'SMtest',
      statusCallbackStatus: 'delivered',
    });
    const { store } = makeStore();
    const handler = createWebhookHandler(makeConfig(provider, store));

    const res = await handler({ body: {}, headers: {} });

    expect(res.status).toBe(200);
    expect(upsertDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(upsertDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sid: 'SMtest', status: 'delivered' }),
    );
  });

  it('does NOT upsert when callback has no sid (no orphan row)', async () => {
    const provider = makeProvider({
      from: '',
      body: '',
      buttonPayload: '',
      isStatusCallback: true,
      statusCallbackStatus: 'delivered',
    });
    const { store } = makeStore();
    const handler = createWebhookHandler(makeConfig(provider, store));

    const res = await handler({ body: {}, headers: {} });

    expect(res.status).toBe(200);
    expect(upsertDeliveryStatus).not.toHaveBeenCalled();
  });
});

// 260617-toz — Fix A. Twilio can redeliver the same inbound webhook on network
// retries. The engine's Step 3.5 dedup gate inserts the MessageSid before
// processing: a P2002 unique-violation means we've already handled this exact
// delivery → skip so session state isn't re-mutated. Any other DB error must
// FAIL OPEN (process the message anyway — never drop a real message). Inbound
// webhooks with no MessageSid (simulator/test paths) skip the gate entirely.
describe('engine — inbound MessageSid dedup (260617-toz)', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  const createMock = vi.mocked(prisma.inboundDedup.create);

  beforeEach(() => {
    createMock.mockReset();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function inbound(sid?: string): IncomingMessage {
    return {
      from: '+27821234567',
      to: '+15550009999',
      body: 'menu',
      buttonPayload: '',
      isStatusCallback: false,
      providerMessageSid: sid,
    };
  }

  it('processes a fresh inbound MessageSid normally (lookupUser called)', async () => {
    createMock.mockResolvedValue({} as any);
    const provider = makeProvider(inbound('SM123'));
    const { store } = makeStore();
    const config = makeConfig(provider, store);
    const handler = createWebhookHandler(config);

    const res = await handler({ body: {}, headers: {} });

    expect(res.status).toBe(200);
    expect(createMock).toHaveBeenCalledWith({ data: { messageSid: 'SM123' } });
    expect(config.lookupUser).toHaveBeenCalled();
  });

  it('skips the duplicate (P2002) — lookupUser NOT called, returns 200', async () => {
    createMock.mockRejectedValue({ code: 'P2002' });
    const provider = makeProvider(inbound('SM123'));
    const { store } = makeStore();
    const config = makeConfig(provider, store);
    const handler = createWebhookHandler(config);

    const res = await handler({ body: {}, headers: {} });

    expect(res.status).toBe(200);
    expect(config.lookupUser).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('duplicate inbound MessageSid'),
    );
  });

  it('fails open on a non-P2002 dedup error (lookupUser still called)', async () => {
    createMock.mockRejectedValue({ code: 'P1001' });
    const provider = makeProvider(inbound('SM123'));
    const { store } = makeStore();
    const config = makeConfig(provider, store);
    const handler = createWebhookHandler(config);

    const res = await handler({ body: {}, headers: {} });

    expect(res.status).toBe(200);
    expect(config.lookupUser).toHaveBeenCalled();
    expect(consoleErrSpy).toHaveBeenCalled();
  });

  it('skips the gate entirely when there is no MessageSid (create not called)', async () => {
    const provider = makeProvider(inbound(undefined));
    const { store } = makeStore();
    const config = makeConfig(provider, store);
    const handler = createWebhookHandler(config);

    const res = await handler({ body: {}, headers: {} });

    expect(res.status).toBe(200);
    expect(createMock).not.toHaveBeenCalled();
    expect(config.lookupUser).toHaveBeenCalled();
  });
});


// ── debug-260902: Step 7 must never fabricate session state ───────────────
//
// Oracle type: SPECIFIED (from the reported prod failure).
//
// A user mid-flow was answered with the main menu after a state-load failure,
// replied "Clair 03 November 1982" — and the bot answered with the main-menu
// greeting. Nothing saved, no error, no confirmation.
//
// The mechanism: Step 7 was `try { state = await store.get() } catch { state = {} }`.
// An empty state reads back as botStatus 'idle', so every status-gated handler
// declines the turn and Step 16 hands a mid-flow user the main menu. An
// INFRASTRUCTURE error had been silently converted into the SEMANTIC claim
// "this user is idle" — which is a lie, and a lossy one.
//
// The contract locked here: a failed state load must never reach the handler
// chain or the fallback, must be retried when transient, and must tell the user
// something explicit.
describe('engine — Step 7 state-load failure (debug-260902 root cause A)', () => {
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  function midAddSetup(getImpl: () => Promise<any>) {
    const handlerCalls: string[] = [];
    const fallbackCalls: string[] = [];
    const provider = makeProvider({
      from: '+27821234567',
      to: '+15550009999',
      body: 'Clair 03 November 1982',
      buttonPayload: '',
      isStatusCallback: false,
    } as any);
    const store = {
      get: vi.fn(getImpl),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      persist: vi.fn().mockResolvedValue(undefined),
    };
    const config = {
      provider,
      store,
      statefulStatuses: ['awaiting_add_anything'],
      globalCommands: [],
      handlers: [
        async (ctx: any) => {
          handlerCalls.push(ctx.status);
          return ctx.status === 'awaiting_add_anything';
        },
      ],
      lookupUser: vi
        .fn()
        .mockResolvedValue({ id: 'u1', firstName: 'Sarah', dob: new Date() }),
      sessionKey: (p: string) => p,
      onFallback: async () => {
        fallbackCalls.push('MAIN_MENU');
      },
    } as unknown as BotConfig;
    return { config, provider, store, handlerCalls, fallbackCalls };
  }

  function transientError() {
    const e: any = new Error(
      'Timed out fetching a new connection from the connection pool',
    );
    e.name = 'PrismaClientInitializationError';
    return e;
  }

  it('does NOT run handlers or the main-menu fallback when the state load fails', async () => {
    const { config, provider, handlerCalls, fallbackCalls } = midAddSetup(
      async () => {
        throw transientError();
      },
    );

    const res = await createWebhookHandler(config)({ body: {}, headers: {} });

    expect(res.status).toBe(200); // Step 3.5 already burned the SID — a 500 would be silence
    expect(handlerCalls).toEqual([]); // never dispatched against fabricated state
    expect(fallbackCalls).toEqual([]); // and never re-blasts the menu
    // The user is told, rather than handed a menu that looks like success.
    expect(provider.sendText).toHaveBeenCalledTimes(1);
  });

  it('never persists or caches a fabricated state after a failed load', async () => {
    const { config, store } = midAddSetup(async () => {
      throw transientError();
    });

    await createWebhookHandler(config)({ body: {}, headers: {} });

    // The durable row must be left exactly as it was, so the user's next
    // message resumes the add flow instead of landing on a wiped session.
    expect(store.persist).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('retries a transient DB error and proceeds normally when it clears', async () => {
    let attempts = 0;
    const { config, handlerCalls, fallbackCalls } = midAddSetup(async () => {
      attempts += 1;
      if (attempts < 3) throw transientError();
      return { botStatus: 'awaiting_add_anything', _lastUserMessageAt: Date.now() };
    });

    await createWebhookHandler(config)({ body: {}, headers: {} });

    expect(attempts).toBe(3); // boundary: recovers on the LAST allowed attempt
    expect(handlerCalls).toEqual(['awaiting_add_anything']);
    expect(fallbackCalls).toEqual([]);
  });

  it('fails fast on a NON-transient error instead of burning retries', async () => {
    let attempts = 0;
    const { config } = midAddSetup(async () => {
      attempts += 1;
      throw new Error('Unknown column BotSession.nope'); // deterministic fault
    });

    await createWebhookHandler(config)({ body: {}, headers: {} });

    expect(attempts).toBe(1);
  });

  it('control: a healthy load still reaches the mid-add handler', async () => {
    const { config, handlerCalls, fallbackCalls } = midAddSetup(async () => ({
      botStatus: 'awaiting_add_anything',
      _lastUserMessageAt: Date.now(),
    }));

    await createWebhookHandler(config)({ body: {}, headers: {} });

    expect(handlerCalls).toEqual(['awaiting_add_anything']);
    expect(fallbackCalls).toEqual([]);
  });
});

// ── debug-260903 S5: Step 11 / Step 13.5 persist guard ────────────────────────
// A store.persist throw at Step 11 (tracking save) or Step 13.5 (nav escape)
// used to propagate out of the webhook handler as an unhandled rejection → HTTP
// 500. Twilio then retried, Step 3.5's InboundDedup row swallowed the retry as a
// duplicate, and the user's message was lost in silence. The in-memory `state`
// is already correctly mutated at both points, so the only correct policy is the
// house one: log-and-continue, dispatch anyway.
describe('engine — Step 11/13.5 persist guard (debug-260903 S5)', () => {
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function throwingPersistStore() {
    const memory = new Map<string, Record<string, any>>();
    return {
      async get(sessionId: string) {
        return memory.get(sessionId) ?? {};
      },
      async set(sessionId: string, state: Record<string, any>) {
        memory.set(sessionId, state);
      },
      async clear(sessionId: string) {
        memory.delete(sessionId);
      },
      persist: vi.fn().mockRejectedValue(new Error('neon blip')),
    };
  }

  it('Step 11: a persist throw still dispatches the message and returns 200', async () => {
    const provider = makeProvider({
      from: '+27821234567',
      to: '+15550009999',
      body: 'hello there',
      buttonPayload: '',
      isStatusCallback: false,
    });
    const store = throwingPersistStore();
    const seen: string[] = [];
    const config = makeConfig(provider, store);
    config.handlers = [
      async (ctx: any) => {
        seen.push(String(ctx.status));
        return true;
      },
    ];

    const res = await createWebhookHandler(config)({ body: {}, headers: {} });

    expect(res.status).toBe(200);
    expect(store.persist).toHaveBeenCalled();
    expect(seen).toEqual(['idle']); // dispatched despite the persist failure
  });

  it('Step 13.5: a nav-escape persist throw still dispatches and returns 200', async () => {
    const navAction = [...TOP_LEVEL_NAV_ACTIONS][0];
    const provider = makeProvider({
      from: '+27821234567',
      to: '+15550009999',
      body: 'tap',
      buttonPayload: navAction,
      isStatusCallback: false,
    });
    const store = throwingPersistStore();
    await store.set('+27821234567', { botStatus: 'awaiting_capture_a' });
    const seen: string[] = [];
    const config = makeConfig(provider, store);
    config.statefulStatuses = ['awaiting_capture_a'];
    config.handlers = [
      async (ctx: any) => {
        seen.push(String(ctx.action));
        return true;
      },
    ];

    const res = await createWebhookHandler(config)({ body: {}, headers: {} });

    expect(res.status).toBe(200);
    expect(seen).toEqual([navAction]);
  });
});

// ── debug-260903 S6: Step 12 global-command guard ─────────────────────────────
// A throwing global command (menu/reset/help/back/skip) escaped as a 500 with no
// reply. Step 15 has guarded handler dispatch since 260617-0js; Step 12 never
// got the same treatment. Mirror it exactly.
describe('engine — Step 12 global-command guard (debug-260903 S6)', () => {
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('a throwing global command returns 200 and sends the graceful fallback', async () => {
    const provider = makeProvider({
      from: '+27821234567',
      to: '+15550009999',
      body: 'menu',
      buttonPayload: '',
      isStatusCallback: false,
    });
    const { store } = makeStore();
    const config = makeConfig(provider, store);
    const boom = vi.fn().mockRejectedValue(new Error('boom'));
    config.globalCommands = [{ match: ['menu'], handle: boom } as any];
    const handlerRan = vi.fn().mockResolvedValue(true);
    config.handlers = [handlerRan];

    const res = await createWebhookHandler(config)({ body: {}, headers: {} });

    expect(res.status).toBe(200);
    expect(boom).toHaveBeenCalledTimes(1);
    expect(provider.sendText).toHaveBeenCalledTimes(1);
    expect((provider.sendText as any).mock.calls[0][0]).toBe('+27821234567');
    expect((provider.sendText as any).mock.calls[0][1]).toEqual(expect.any(String));
    // The request ends at the catch — no double-handling downstream.
    expect(handlerRan).not.toHaveBeenCalled();
  });

  it('a failing fallback send inside the guard still returns 200', async () => {
    const provider = makeProvider({
      from: '+27821234567',
      to: '+15550009999',
      body: 'menu',
      buttonPayload: '',
      isStatusCallback: false,
    });
    (provider.sendText as any).mockRejectedValue(new Error('twilio down'));
    const { store } = makeStore();
    const config = makeConfig(provider, store);
    config.globalCommands = [
      { match: ['menu'], handle: vi.fn().mockRejectedValue(new Error('boom')) } as any,
    ];

    const res = await createWebhookHandler(config)({ body: {}, headers: {} });

    expect(res.status).toBe(200);
  });
});
