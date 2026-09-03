// Echo demo — the smallest possible sticky capture flow. The bot holds
// awaiting_echo_text and consumes free text until the user leaves via
// back / menu / skip (SKIP_MAP sends skip → idle). Replace with your first
// real feature; the shape (start fn + status-gated handler) is the pattern.

import type { Handler, HandlerContext } from '../core/types.js';
import { msgEchoIntro, msgEchoReply } from '../copy/index.js';

export async function startEchoDemo(ctx: HandlerContext): Promise<void> {
  await ctx.setState({ botStatus: 'awaiting_echo_text' });
  await ctx.send.sendText(ctx.phone, msgEchoIntro());
}

export const handleEcho: Handler = async (ctx) => {
  if (ctx.status !== 'awaiting_echo_text') return false;
  if (!ctx.text) return false; // whitespace-only → onFallback re-prompts
  await ctx.send.sendText(ctx.phone, msgEchoReply(ctx.text));
  return true; // stay in the flow — back/menu/skip are the exits
};
