// debug-260902 — the session cache must revalidate, not remember.
//
// Oracle type: SPECIFIED (derived from the prod failure) + DERIVED (the store's
// own contract: BotSession is the durable source of truth; the Map is a cache).
//
// prisma-store.get() used to be write-once:
//
//     const cached = memory.get(sessionId);
//     if (cached && Object.keys(cached).length > 0) return cached;
//
// Once an instance had seen a session it NEVER re-read BotSession again. On
// Vercel that is a correctness bug, not an optimisation: several lambdas serve
// the same user. Instance A handles the "+ Add birthday or event" tap and
// writes botStatus='awaiting_add_anything'; instance B — warm, still holding
// this session at 'idle' from an earlier turn — handles the reply, serves its
// stale cache, every handler declines the turn, and the user's add is answered
// with the main-menu greeting and thrown away. That is the reported bug, and it
// needs no database error at all.
//
// These tests pin the corrected contract: durable fields always come from the
// row; only NON-durable scratch (which has no column) survives from the cache.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn().mockResolvedValue({});

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    botSession: {
      findUnique: (...args: any[]) => findUnique(...args),
      upsert: (...args: any[]) => upsert(...args),
    },
  },
}));

const { createPrismaStore } = await import('./prisma-store.js');

const SESSION = '+27821234567';

function row(overrides: Record<string, any> = {}) {
  return {
    id: SESSION,
    botStatus: 'idle',
    lastMenu: null,
    lastMessageAt: new Date('2026-09-02T07:19:00Z'),
    pendingReferralCode: null,
    draftFirstName: null,
    draftSurname: null,
    pendingFriendId: null,
    draftEventTitle: null,
    draftEventType: null,
    draftEventDate: null,
    draftEventAllDay: null,
    draftEventTime: null,
    draftEventRecurring: null,
    draftManageEventId: null,
    lastSenderFrom: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('prisma-store.get — durable revalidation (debug-260902 root cause A)', () => {
  it('reads BotSession on EVERY get, even for a session it has already cached', async () => {
    const store = createPrismaStore();
    findUnique.mockResolvedValue(row());

    await store.get(SESSION);
    await store.get(SESSION);
    await store.get(SESSION);

    expect(findUnique).toHaveBeenCalledTimes(3);
  });

  it('serves the DB status over a stale cached one (the cross-instance case)', async () => {
    const store = createPrismaStore();

    // This instance last saw the user idle.
    findUnique.mockResolvedValue(row({ botStatus: 'idle' }));
    const before = await store.get(SESSION);
    expect(before.botStatus).toBe('idle');

    // Another lambda has since armed the add flow on the shared row.
    findUnique.mockResolvedValue(row({ botStatus: 'awaiting_add_anything' }));
    const after = await store.get(SESSION);

    expect(after.botStatus).toBe('awaiting_add_anything');
  });

  it('recovers a session whose cache was poisoned by a failed load', async () => {
    const store = createPrismaStore();

    // Simulates the old Step 7 fallback: a botStatus-less object written back
    // into the Map. This used to wedge the session for the life of the instance.
    await store.set(SESSION, {
      _lastUserMessage: 'clair 03 november 1982',
      _lastUserMessageAt: Date.now(),
      _lastKnownBotStatus: 'idle',
    });
    findUnique.mockResolvedValue(row({ botStatus: 'awaiting_add_anything' }));

    const state = await store.get(SESSION);

    expect(state.botStatus).toBe('awaiting_add_anything');
  });

  it('lets a durable NULL clear a cached value rather than resurrecting it', async () => {
    const store = createPrismaStore();

    findUnique.mockResolvedValue(row({ draftFirstName: 'Clair' }));
    expect((await store.get(SESSION)).draftFirstName).toBe('Clair');

    // The flow completed and cleared the draft on the row.
    findUnique.mockResolvedValue(row({ draftFirstName: null }));
    expect((await store.get(SESSION)).draftFirstName).toBeUndefined();
  });

  it('preserves NON-durable scratch that has no BotSession column', async () => {
    const store = createPrismaStore();

    // draftMonth/draftDay/draftYear have no column — they live only in the Map,
    // and finalizeManualSave still guards against losing them. Revalidating the
    // durable fields must not take these with it.
    await store.set(SESSION, {
      botStatus: 'awaiting_add_manual_relationship',
      draftMonth: 11,
      draftDay: 3,
      draftYear: 1982,
      _repeatCount: 2,
    });
    findUnique.mockResolvedValue(
      row({ botStatus: 'awaiting_add_manual_relationship' }),
    );

    const state = await store.get(SESSION);

    expect(state.draftMonth).toBe(11);
    expect(state.draftDay).toBe(3);
    expect(state.draftYear).toBe(1982);
    expect(state._repeatCount).toBe(2);
    expect(state.botStatus).toBe('awaiting_add_manual_relationship');
  });

  it('keeps in-memory scratch when no durable row exists yet (first contact)', async () => {
    const store = createPrismaStore();
    await store.set(SESSION, { botStatus: 'awaiting_firstName' });
    findUnique.mockResolvedValue(null);

    expect((await store.get(SESSION)).botStatus).toBe('awaiting_firstName');
  });

  it('returns an empty state for a brand-new session with no row and no cache', async () => {
    const store = createPrismaStore();
    findUnique.mockResolvedValue(null);

    expect(await store.get('+27829999999')).toEqual({});
  });

  it('does not let a null lastMessageAt reset the session-timeout clock', async () => {
    const store = createPrismaStore();
    const ts = Date.now();
    await store.set(SESSION, { _lastUserMessageAt: ts });
    findUnique.mockResolvedValue(row({ lastMessageAt: null }));

    // Boundary: a null column must not blank a live timestamp, or checkTimeout
    // would see "no activity" and stop protecting the flow.
    expect((await store.get(SESSION))._lastUserMessageAt).toBe(ts);
  });

  it('propagates a read failure instead of masking it as an empty session', async () => {
    const store = createPrismaStore();
    findUnique.mockRejectedValue(new Error('could not be reached'));

    // The engine decides what to do with this (retry, then tell the user).
    // The store must not answer "this user has no state".
    await expect(store.get(SESSION)).rejects.toThrow('could not be reached');
  });
});
