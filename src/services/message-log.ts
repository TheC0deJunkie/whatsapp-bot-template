// 260610-o06 — Fire-and-forget WhatsApp message logger.
//
// logMessage writes one row to the Message table via Prisma. It MUST NEVER
// throw or propagate a rejection — it uses a .catch() so callers can safely
// void the return value without try/catch scaffolding. A DB failure is logged
// with [message-log] prefix and swallowed; the webhook path continues.

import { prisma } from '../lib/prisma.js';

export interface LogMessageInput {
  phone: string;
  userId?: string | null;
  direction: 'inbound' | 'outbound';
  body: string;
  method?: string | null;
}

export function logMessage(input: LogMessageInput): void {
  prisma.message
    .create({
      data: {
        phone: input.phone,
        userId: input.userId ?? null,
        direction: input.direction,
        body: input.body,
        method: input.method ?? null,
      },
    })
    .catch((err: unknown) => {
      console.error('[message-log] write failed:', err);
    });
}
