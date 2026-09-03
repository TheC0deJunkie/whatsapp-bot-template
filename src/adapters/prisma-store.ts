import type { StoreAdapter, DurableFields } from '../core/types.js';
import { prisma } from '../lib/prisma.js';

/**
 * Prisma-backed conversation store.
 *
 * Hybrid model:
 *   - hot path:    in-memory Map carries NON-durable scratch within a warm instance
 *   - durable:     the BotSession row is ALWAYS the source of truth for durable fields
 *
 * session.id is the sessionKey — for this app that's the normalized E.164
 * phone number (see botConfig.sessionKey). The key choice is deliberately
 * decoupled from User.id so unknown/not-yet-created users still have state.
 */

const memory = new Map<string, Record<string, any>>();

/**
 * Invalidate the in-memory cache for a session. Use when another handler
 * mutates a session row in the DB directly (e.g. flipping ANOTHER user's
 * status from inside this user's turn). On the next webhook for that session,
 * the store will read fresh state from the DB.
 */
export function invalidateSessionCache(sessionId: string): void {
  memory.delete(sessionId);
}

export function createPrismaStore(): StoreAdapter {
  return {
    // PRODUCTION LESSON — never make this a write-once cache. Serverless
    // platforms run several concurrent instances; an instance that caches
    // durable state forever serves stale botStatus and silently swallows
    // mid-flow replies. The DB row is ALWAYS re-read for durable fields; the
    // Map survives only as a carrier for NON-durable scratch that has no
    // column (_repeatCount, _lastUserMessage, transient drafts), merged UNDER
    // the freshly-read durable fields. Cost is one indexed findUnique per
    // inbound message — the price of not lying about state.
    async get(sessionId) {
      const cached = memory.get(sessionId) ?? {};

      const row = await prisma.botSession.findUnique({
        where: { id: sessionId },
      });
      // No durable row yet (first ever contact) — keep whatever scratch the
      // instance holds rather than blanking it.
      if (!row) {
        return Object.keys(cached).length > 0 ? cached : {};
      }

      const durable: Record<string, any> = {
        botStatus: row.botStatus || 'idle',
        lastMenu: row.lastMenu ? JSON.parse(row.lastMenu) : null,
        _lastUserMessageAt: row.lastMessageAt?.getTime(),
        draftFirstName: row.draftFirstName ?? undefined,
        draftSurname: row.draftSurname ?? undefined,
        lastSenderFrom: row.lastSenderFrom ?? undefined,
      };

      // Durable wins over scratch. `lastMessageAt` is the one field we do NOT
      // let a null row value clobber — the engine keeps _lastUserMessageAt in
      // memory within a turn and the column is written on every inbound, so a
      // transient null must not reset the session-timeout clock.
      if (durable._lastUserMessageAt === undefined) {
        delete durable._lastUserMessageAt;
      }
      const state: Record<string, any> = { ...cached, ...durable };
      memory.set(sessionId, state);
      return state;
    },

    async set(sessionId, state) {
      memory.set(sessionId, state);
    },

    async clear(sessionId) {
      memory.delete(sessionId);
      await prisma.botSession
        .delete({ where: { id: sessionId } })
        .catch(() => {});
    },

    // Route DurableFields to BotSession columns. To add a durable field:
    // schema column + DurableFields entry + a mapping in get() and here.
    async persist(sessionId, fields: DurableFields) {
      const data: Record<string, any> = {};

      if (fields.botStatus !== undefined) data.botStatus = fields.botStatus;
      if (fields.lastMenu !== undefined) {
        data.lastMenu = fields.lastMenu ? JSON.stringify(fields.lastMenu) : null;
      }
      if (fields._lastUserMessageAt !== undefined) {
        const ts = Number(fields._lastUserMessageAt);
        data.lastMessageAt = Number.isFinite(ts) ? new Date(ts) : null;
      }
      if (fields.draftFirstName !== undefined) {
        data.draftFirstName = fields.draftFirstName ?? null;
      }
      if (fields.draftSurname !== undefined) {
        data.draftSurname = fields.draftSurname ?? null;
      }
      if (fields.lastSenderFrom !== undefined) {
        data.lastSenderFrom = fields.lastSenderFrom ?? null;
      }

      if (Object.keys(data).length === 0) return;

      await prisma.botSession.upsert({
        where: { id: sessionId },
        create: { id: sessionId, ...data },
        update: data,
      });
    },
  };
}
