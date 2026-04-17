/**
 * Example: Prisma-backed store adapter.
 *
 * This is a REFERENCE IMPLEMENTATION — uncomment and adapt for your schema.
 * The pattern mirrors the production EAZYHR bot's hybrid persistence:
 *
 * - Hot path: in-memory Map for fast reads during a conversation
 * - Cold start: DB seed when the Map is empty (Vercel function restart)
 * - Durable writes: only botStatus + lastMenu persisted to DB
 *
 * Your Prisma schema needs something like:
 *
 *   model BotSession {
 *     id            String   @id          // session key (phone or user ID)
 *     botStatus     String   @default("idle")
 *     lastMenu      String?               // JSON-stringified MenuButton[]
 *     preferredMode String?
 *     updatedAt     DateTime @updatedAt
 *   }
 */

/*
import type { StoreAdapter, DurableFields } from '../core/types.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const memory = new Map<string, Record<string, any>>();

export function createPrismaStore(): StoreAdapter {
  return {
    async get(sessionId: string) {
      // Hot path: return from memory if available
      const cached = memory.get(sessionId);
      if (cached && Object.keys(cached).length > 0) {
        return cached;
      }

      // Cold start: seed from DB
      const row = await prisma.botSession.findUnique({
        where: { id: sessionId },
      });

      if (!row) return {};

      const state: Record<string, any> = {
        botStatus: row.botStatus || 'idle',
        lastMenu: row.lastMenu ? JSON.parse(row.lastMenu) : null,
        preferredMode: row.preferredMode || undefined,
      };

      memory.set(sessionId, state);
      return state;
    },

    async set(sessionId: string, state: Record<string, any>) {
      memory.set(sessionId, state);
    },

    async clear(sessionId: string) {
      memory.delete(sessionId);
      await prisma.botSession.delete({
        where: { id: sessionId },
      }).catch(() => {});
    },

    async persist(sessionId: string, fields: DurableFields) {
      const data: Record<string, any> = {};

      if (fields.botStatus !== undefined) {
        data.botStatus = fields.botStatus;
      }
      if (fields.lastMenu !== undefined) {
        data.lastMenu = fields.lastMenu
          ? JSON.stringify(fields.lastMenu)
          : null;
      }
      if ('preferredMode' in fields) {
        data.preferredMode = fields.preferredMode ?? null;
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
*/

export {};
