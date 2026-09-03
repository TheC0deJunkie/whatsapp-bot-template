// 260616-glb — Tests for the pure WhatsApp error-code lookup map.

import { describe, it, expect } from 'vitest';
import { lookupErrorCode } from './whatsapp-error-codes.js';

describe('lookupErrorCode — penalty signal codes', () => {
  it('63016 (outside 24h window) is a penalty signal', () => {
    expect(lookupErrorCode('63016').isPenaltySignal).toBe(true);
  });

  it('131047 (re-engagement rate limit) is a penalty signal', () => {
    expect(lookupErrorCode('131047').isPenaltySignal).toBe(true);
  });

  it('131049 (per-user marketing cap) is a penalty signal', () => {
    expect(lookupErrorCode('131049').isPenaltySignal).toBe(true);
  });
});

describe('lookupErrorCode — non-penalty known codes', () => {
  it('131026 (undeliverable) is NOT a penalty signal', () => {
    expect(lookupErrorCode('131026').isPenaltySignal).toBe(false);
  });

  it('131050 (user stopped marketing) is NOT a penalty signal', () => {
    expect(lookupErrorCode('131050').isPenaltySignal).toBe(false);
  });
});

describe('lookupErrorCode — unknown / missing codes', () => {
  it('unknown code returns isPenaltySignal:false', () => {
    expect(lookupErrorCode('99999').isPenaltySignal).toBe(false);
  });

  it('unknown code reason mentions "unknown"', () => {
    expect(lookupErrorCode('99999').reason).toMatch(/unknown/i);
  });

  it('null code returns the unknown fallback', () => {
    expect(lookupErrorCode(null).isPenaltySignal).toBe(false);
    expect(lookupErrorCode(null).reason).toMatch(/unknown/i);
  });

  it('undefined code returns the unknown fallback', () => {
    expect(lookupErrorCode(undefined).reason).toMatch(/unknown/i);
  });
});
