// Request-scoped sender frame: which Twilio number the inbound webhook hit, and
// whether that's the Twilio sandbox sender. Read by:
//   - src/adapters/twilio.ts::twilioSend  → routes the outbound `From` line
//   - src/copy/share.ts::msgShareInvite   → swaps wa.me link + prefill
// Set by:
//   - src/adapters/twilio.ts::createTwilioWebhookHandler  → wraps the engine handler
// Outside any frame (cron, scripts, tests without runWithSender) → returns undefined,
// callers default to the primary prod sender.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface SenderFrame {
  /** E.164 of the OUTBOUND From number, no "whatsapp:" prefix (e.g. "+14155238886") */
  from: string;
  /** True when this conversation is on the Twilio shared sandbox sender. */
  isSandbox: boolean;
}

const storage = new AsyncLocalStorage<SenderFrame>();

export function runWithSender<T>(
  frame: SenderFrame,
  fn: () => Promise<T> | T,
): Promise<T> {
  // storage.run returns whatever fn returns; Promise.resolve lets callers
  // `await` even when fn is synchronous.
  return Promise.resolve(storage.run(frame, fn));
}

export function getActiveSender(): SenderFrame | undefined {
  return storage.getStore();
}
