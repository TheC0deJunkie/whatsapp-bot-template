import { describe, it, expect } from 'vitest';
import { resolveAction } from './action-resolver.js';
import type { IncomingMessage, MenuButton } from './types.js';

function msg(body: string, buttonPayload = ''): IncomingMessage {
  return {
    from: '+15550001111',
    body,
    buttonPayload,
    isStatusCallback: false,
  };
}

// A 13-entry picker mirroring the live gift-ideas list that surfaced the
// two-digit regression. ids encode the index so assertions stay readable.
const BIG_MENU: MenuButton[] = Array.from({ length: 13 }, (_, i) => ({
  id: `pick_${i + 1}`,
  title: `Person ${i + 1}`,
}));

describe('resolveAction — numeric layer', () => {
  it('resolves single-digit taps to the matching button', () => {
    expect(resolveAction(msg('1'), BIG_MENU)).toBe('pick_1');
    expect(resolveAction(msg('5'), BIG_MENU)).toBe('pick_5');
    expect(resolveAction(msg('9'), BIG_MENU)).toBe('pick_9');
  });

  // Regression: '^[1-9]$' rejected two-digit input, so list entries past 9
  // silently fell through to the raw-text fallback and bounced to the menu.
  it('resolves two-digit taps for lists longer than 9 entries', () => {
    expect(resolveAction(msg('10'), BIG_MENU)).toBe('pick_10');
    expect(resolveAction(msg('11'), BIG_MENU)).toBe('pick_11');
    expect(resolveAction(msg('12'), BIG_MENU)).toBe('pick_12');
    expect(resolveAction(msg('13'), BIG_MENU)).toBe('pick_13');
  });

  it('falls through when the numeric index is out of range', () => {
    // '14' has no button — bounds check fails, raw text is returned.
    expect(resolveAction(msg('14'), BIG_MENU)).toBe('14');
    expect(resolveAction(msg('99'), BIG_MENU)).toBe('99');
  });

  it('does not treat "0" or leading-zero input as an index', () => {
    expect(resolveAction(msg('0'), BIG_MENU)).toBe('0');
    expect(resolveAction(msg('01'), BIG_MENU)).toBe('01');
  });

  it('ignores numeric input when there is no menu', () => {
    expect(resolveAction(msg('11'), null)).toBe('11');
    expect(resolveAction(msg('3'), [])).toBe('3');
  });
});

describe('resolveAction — priority layers', () => {
  it('prefers a raw button payload over everything', () => {
    expect(resolveAction(msg('1', 'gift_cancel'), BIG_MENU)).toBe('gift_cancel');
  });

  it('matches a button title exactly (emoji-stripped, case-insensitive)', () => {
    const menu: MenuButton[] = [{ id: 'open_gifts', title: '🎁 Gift Ideas' }];
    expect(resolveAction(msg('gift ideas'), menu)).toBe('open_gifts');
  });

  it('matches a button title by starts-with for 3+ chars', () => {
    const menu: MenuButton[] = [{ id: 'open_gifts', title: 'Gift Ideas' }];
    expect(resolveAction(msg('gif'), menu)).toBe('open_gifts');
  });

  it('falls back to lowercased raw text', () => {
    expect(resolveAction(msg('Hello'), null)).toBe('hello');
    expect(resolveAction(msg('   '), BIG_MENU)).toBe('');
  });
});
