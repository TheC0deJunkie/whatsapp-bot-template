// 260616-glb — Fire-and-forget delivery lifecycle logger.
// seedDelivery: called at send-time with the provider SID. Never throws.
// upsertDeliveryStatus: called on status callback; upserts by SID.
// Both swallow errors so they never block the webhook or send path — mirrors
// the logMessage pattern in message-log.ts exactly.

import { prisma } from '../lib/prisma.js';

export interface SeedDeliveryInput {
  sid: string;
  phone: string;
  userId?: string | null;
  method?: string | null;
}

export interface UpsertDeliveryInput {
  sid: string;
  status: string; // delivered|read|failed|undelivered|queued|sent
  errorCode?: string;
  errorMessage?: string;
}

export function seedDelivery(input: SeedDeliveryInput): void {
  prisma.messageDelivery
    .create({
      data: {
        sid: input.sid,
        phone: input.phone,
        userId: input.userId ?? null,
        method: input.method ?? null,
        status: 'sent',
      },
    })
    .catch((err: unknown) => {
      console.error('[delivery-log] seed failed:', err);
    });
}

export function upsertDeliveryStatus(input: UpsertDeliveryInput): void {
  const now = new Date();
  const timestamps: Record<string, Date | undefined> = {};
  if (input.status === 'delivered') timestamps.deliveredAt = now;
  if (input.status === 'read') timestamps.readAt = now;
  if (input.status === 'failed' || input.status === 'undelivered') timestamps.failedAt = now;

  prisma.messageDelivery
    .upsert({
      where: { sid: input.sid },
      // create-path may fire when a callback lands before the seed row (e.g.
      // very fast delivery). phone:'' is accepted for v1 — the seed fills it
      // when it arrives, and the unique sid keeps this idempotent.
      create: {
        sid: input.sid,
        phone: '',
        status: input.status,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        ...timestamps,
      },
      update: {
        status: input.status,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        ...timestamps,
      },
    })
    .catch((err: unknown) => {
      console.error('[delivery-log] upsert failed:', err);
    });
}
