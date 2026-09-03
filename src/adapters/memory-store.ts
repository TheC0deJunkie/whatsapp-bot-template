import type { StoreAdapter, DurableFields } from '../core/types.js';

/**
 * In-memory conversation store.
 * Fast, zero-dependency, works everywhere.
 *
 * Limitations:
 * - State is lost on server restart / cold start
 * - Not shared across Vercel function instances
 *
 * For production with Vercel, pair with a DB-backed persist()
 * or use the Prisma store adapter. The in-memory layer still
 * handles hot-path reads; persist() writes durable fields to DB
 * so cold starts can recover via get().
 */

const store = new Map<string, Record<string, any>>();

export function createMemoryStore(): StoreAdapter {
  return {
    async get(sessionId: string) {
      return store.get(sessionId) ?? {};
    },

    async set(sessionId: string, state: Record<string, any>) {
      store.set(sessionId, state);
    },

    async clear(sessionId: string) {
      store.delete(sessionId);
    },

    async persist(_sessionId: string, _fields: DurableFields) {
      // No-op for pure in-memory. The data is already in the Map.
      // Override this in a DB-backed store to write durable fields.
    },
  };
}
