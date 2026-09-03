import { describe, it, expect } from 'vitest';
import { timezoneFromPhone, isValidTimezone } from './timezone.js';

describe('timezoneFromPhone', () => {
  it('maps single-timezone countries exactly', () => {
    expect(timezoneFromPhone('+27680815781')).toBe('Africa/Johannesburg'); // SA
    expect(timezoneFromPhone('+447911123456')).toBe('Europe/London'); // UK
    expect(timezoneFromPhone('+263772000000')).toBe('Africa/Harare'); // Zimbabwe
    expect(timezoneFromPhone('+919812345678')).toBe('Asia/Kolkata'); // India
  });

  it('uses a representative zone for multi-timezone countries', () => {
    expect(timezoneFromPhone('+14155550123')).toBe('America/New_York'); // US
    expect(timezoneFromPhone('+61412345678')).toBe('Australia/Sydney'); // AU
    expect(timezoneFromPhone('+5511999999999')).toBe('America/Sao_Paulo'); // BR
  });

  it('prefers the longest matching calling code', () => {
    // +1242 (Bahamas) must beat the +1 (US) prefix.
    expect(timezoneFromPhone('+12423001234')).toBe('America/Nassau');
  });

  it('returns null for unknown / empty input', () => {
    expect(timezoneFromPhone('+9990000000')).toBeNull(); // no such code mapped
    expect(timezoneFromPhone('')).toBeNull();
    expect(timezoneFromPhone(null)).toBeNull();
    expect(timezoneFromPhone(undefined)).toBeNull();
  });

  it('tolerates non-E.164 formatting (strips non-digits)', () => {
    expect(timezoneFromPhone('+27 (068) 081-5781')).toBe('Africa/Johannesburg');
  });

  it('every mapped zone is a valid IANA timezone', () => {
    const samples = [
      '+27x', '+44x', '+1x', '+61x', '+91x', '+234x', '+971x', '+55x', '+7x',
      '+12421',
    ];
    for (const p of samples) {
      const tz = timezoneFromPhone(p);
      expect(tz, p).not.toBeNull();
      expect(isValidTimezone(tz as string), `${p} -> ${tz}`).toBe(true);
    }
  });
});
