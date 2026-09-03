import { describe, it, expect } from 'vitest';
import { looksLikePhone, maskPhone, normalizePhone } from './phone.js';

// 260830-ehs-fix — regression lock. normalizePhone COERCES any stray digits into
// a plausible +27 number, so it can never be used to decide "is this a phone?".
// On the live bot that mistake turned "Test Melons 23 September 1967" into
// "+27231967" and answered a birthday with an invite link.
describe('looksLikePhone', () => {
  it('accepts real phone shapes', () => {
    expect(looksLikePhone('+27 82 123 4567')).toBe(true);
    expect(looksLikePhone('0821234567')).toBe(true);
    expect(looksLikePhone('+27821234567')).toBe(true);
    expect(looksLikePhone('082 123 4567')).toBe(true);
    expect(looksLikePhone('(082) 123-4567')).toBe(true);
    expect(looksLikePhone('whatsapp:+27821234567')).toBe(true);
  });

  it('rejects name + date text, even when it carries enough digits to coerce', () => {
    expect(looksLikePhone('Test Melons 23 September 1967')).toBe(false);
    expect(looksLikePhone('Thandi 14 Sep 1995')).toBe(false);
    expect(looksLikePhone('Mom & Dad anniversary 12 Oct')).toBe(false);
    expect(looksLikePhone('Sarah 3 March')).toBe(false);
    expect(looksLikePhone('hello')).toBe(false);
    expect(looksLikePhone('17/04/1992')).toBe(false);
    expect(looksLikePhone('')).toBe(false);
  });

  it('rejects digit strings outside phone length (8 digits, 16 digits)', () => {
    expect(looksLikePhone('23 09 1967')).toBe(false);
    expect(looksLikePhone('1234567890123456')).toBe(false);
  });

  it('is strictly narrower than the normalizePhone shape test it replaced', () => {
    // The old detector: /^\+\d{8,15}$/.test(normalizePhone(text)) — true here.
    expect(normalizePhone('Test Melons 23 September 1967')).toBe('+27231967');
    expect(/^\+\d{8,15}$/.test(normalizePhone('Test Melons 23 September 1967'))).toBe(true);
    expect(looksLikePhone('Test Melons 23 September 1967')).toBe(false);
  });
});

describe('maskPhone', () => {
  it('keeps country code + last 3 digits, masks the middle', () => {
    expect(maskPhone('+27824029781')).toBe('+27••••••781');
  });

  it('normalizes first so whatsapp: prefixes and local formats mask the same', () => {
    expect(maskPhone('whatsapp:+27824029781')).toBe('+27••••••781');
    expect(maskPhone('0824029781')).toBe('+27••••••781');
    expect(maskPhone('082 402 9781')).toBe('+27••••••781');
  });

  it('never leaks the full number', () => {
    const masked = maskPhone('+27824029781');
    expect(masked).not.toContain('4029');
    expect(masked).not.toContain('82402');
  });

  it('handles empty / null / garbage without throwing', () => {
    expect(maskPhone('')).toBe('(no phone)');
    expect(maskPhone(null)).toBe('(no phone)');
    expect(maskPhone(undefined)).toBe('(no phone)');
    expect(maskPhone('abc')).toBe('(masked)');
  });

  it('is a pure log helper — normalizePhone output is untouched', () => {
    expect(normalizePhone('0824029781')).toBe('+27824029781');
  });
});

// 260903-ek8 (A6) — "00" is the international DIALING prefix, not a national
// trunk zero. The old single-leading-zero branch stripped ONE zero and
// re-prepended the default country code, so "00 27 82 123 4567" became the
// garbled "+27027821234567".
describe('toE164 / normalizePhone — "00" international prefix (260903-ek8 A6)', () => {
  it('normalizes a spaced SA number behind a "00" prefix', () => {
    expect(normalizePhone('00 27 82 123 4567')).toBe('+27821234567');
  });

  it('normalizes the same number unspaced', () => {
    expect(normalizePhone('0027821234567')).toBe('+27821234567');
  });

  it('keeps a foreign country code intact (US)', () => {
    expect(normalizePhone('00 1 415 555 2671')).toBe('+14155552671');
  });

  it('leaves the single-leading-zero SA-local branch untouched', () => {
    expect(normalizePhone('0821234567')).toBe('+27821234567');
  });
});
