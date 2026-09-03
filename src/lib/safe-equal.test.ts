import { describe, it, expect } from 'vitest';
import { safeEqual } from './safe-equal.js';

describe('safeEqual', () => {
  it('true for identical strings', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('', '')).toBe(true);
  });

  it('false for different strings of the same length', () => {
    expect(safeEqual('abc123', 'abc124')).toBe(false);
  });

  it('false (not throw) for different lengths — the raw timingSafeEqual footgun', () => {
    expect(() => safeEqual('short', 'a-much-longer-string')).not.toThrow();
    expect(safeEqual('short', 'a-much-longer-string')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });

  it('compares bytes, not JS string length (multi-byte UTF-8)', () => {
    expect(safeEqual('é', 'é')).toBe(true);
    expect(safeEqual('é', 'e')).toBe(false);
  });

  it('false for non-string inputs instead of throwing', () => {
    expect(safeEqual(undefined as unknown as string, 'x')).toBe(false);
    expect(safeEqual('x', null as unknown as string)).toBe(false);
  });
});
