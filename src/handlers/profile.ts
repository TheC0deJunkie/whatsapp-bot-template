// Profile — view card + edit name. Demonstrates a two-level flow:
// a menu status (awaiting_profile_menu) and a text-capture status
// (awaiting_edit_firstName), with `back` wired between them in BACK_MAP.

import type { Handler, HandlerContext, MenuButton } from '../core/types.js';
import { prisma } from '../lib/prisma.js';
import {
  msgProfileCard,
  msgAskNewName,
  msgNameUpdated,
} from '../copy/index.js';
import { splitFullName } from '../services/name.js';

export const PROFILE_MENU: MenuButton[] = [
  { id: 'edit_name', title: '✏️ Edit name' },
  { id: 'nav_menu', title: '← Main Menu' },
];

export async function showProfileCard(ctx: HandlerContext): Promise<void> {
  await ctx.setState({ botStatus: 'awaiting_profile_menu' });
  await ctx.setMenu(PROFILE_MENU);
  await ctx.send.sendInteractive(
    ctx.phone,
    msgProfileCard(
      String(ctx.user?.firstName ?? ''),
      ctx.user?.surname ?? null,
      ctx.phone,
    ),
    PROFILE_MENU,
  );
}

export const handleProfile: Handler = async (ctx) => {
  const { status, action, text } = ctx;

  if (status === 'awaiting_profile_menu') {
    if (action === 'edit_name') {
      await ctx.setState({ botStatus: 'awaiting_edit_firstName' });
      await ctx.send.sendText(ctx.phone, msgAskNewName());
      return true;
    }
    // nav_menu is handled by handleNav at the front of the chain.
    return false;
  }

  if (status === 'awaiting_edit_firstName') {
    if (!text) return false; // whitespace-only → onFallback re-prompts
    const { firstName, surname } = splitFullName(text);
    if (!firstName) return false;
    await prisma.user.update({
      where: { id: ctx.user.id },
      data: { firstName, surname },
    });
    ctx.user.firstName = firstName;
    ctx.user.surname = surname;
    await ctx.send.sendText(ctx.phone, msgNameUpdated(firstName));
    await showProfileCard(ctx);
    return true;
  }

  return false;
};
