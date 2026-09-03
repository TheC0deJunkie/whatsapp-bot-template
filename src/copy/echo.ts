// Echo demo copy — the smallest possible "sticky capture flow": the bot holds
// a status (awaiting_echo_text) and consumes free text until the user leaves
// via back / menu / skip. Replace this flow with your first real feature.

import { FOOTER_BACK_MENU } from './footer.js';

export const msgEchoIntro = (): string =>
  'Echo demo 🗣️ — send me anything and I\'ll repeat it back.' + FOOTER_BACK_MENU;

export const msgEchoReply = (text: string): string => `You said: "${text}"`;
