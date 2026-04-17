import type { IncomingMessage, MenuButton } from './types.js';

/**
 * 5-layer action resolution pipeline.
 * Extracted from the production bot's proven resolution logic.
 *
 * Priority order:
 * 1. Raw button payload (provider returns button ID directly)
 * 2. Numeric input → lastMenu index (user types "1", "2", etc.)
 * 3. Title text exact match (user types the button label)
 * 4. Title text partial match (user types part of a button label)
 * 5. Raw text fallback
 */

const EMOJI_REGEX =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

function cleanTitle(title: string): string {
  return title.replace(EMOJI_REGEX, '').trim().toLowerCase();
}

export function resolveAction(
  message: IncomingMessage,
  lastMenu: MenuButton[] | null | undefined,
): string {
  // Layer 1: Raw button payload from provider
  const payload = message.buttonPayload?.trim();
  if (payload) return payload.toLowerCase();

  const text = message.body.trim();
  const textLower = text.toLowerCase();

  if (!textLower) return '';

  // Layer 2: Numeric input → lastMenu index lookup
  if (/^[1-9]$/.test(textLower) && lastMenu?.length) {
    const idx = parseInt(textLower, 10) - 1;
    if (idx < lastMenu.length) return lastMenu[idx].id;
  }

  // Layer 3: Exact title match (emoji-stripped)
  if (lastMenu?.length) {
    const exact = lastMenu.find((b) => cleanTitle(b.title) === textLower);
    if (exact) return exact.id;
  }

  // Layer 4: Partial title match (starts-with)
  if (textLower.length >= 3 && lastMenu?.length) {
    const partial = lastMenu.find((b) =>
      cleanTitle(b.title).startsWith(textLower),
    );
    if (partial) return partial.id;
  }

  // Layer 5: Raw text fallback
  return textLower;
}
