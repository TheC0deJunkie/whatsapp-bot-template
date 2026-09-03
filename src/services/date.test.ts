import { describe, it, expect } from 'vitest';
import {
  parseBirthday,
  formatBirthday,
  splitNameAndBirthday,
  ageFromBirthday,
  resolveYearFromAge,
  isDateToken, // 260830-glz (WS2) — now exported for add-circle's bare-name check
} from './date.js';

const NOW = new Date('2026-04-17T12:00:00Z');

// 260816-eky — month/day-accurate age helpers.
describe('ageFromBirthday', () => {
  it('counts the birthday itself as passed', () => {
    // NOW is 17 April 2026; born 17 April 2019 → turns 7 today.
    expect(ageFromBirthday({ year: 2019, month: 4, day: 17 }, NOW)).toBe(7);
  });

  it('is one less than the naive year diff the day BEFORE the birthday', () => {
    // Born 18 April 2019 — birthday is tomorrow, so still 6, not 7.
    expect(ageFromBirthday({ year: 2019, month: 4, day: 18 }, NOW)).toBe(6);
    expect(NOW.getUTCFullYear() - 2019).toBe(7); // the old, wrong shorthand
  });

  it('matches the naive year diff once the birthday has passed', () => {
    expect(ageFromBirthday({ year: 2019, month: 1, day: 3 }, NOW)).toBe(7);
  });

  it('handles a December birthday from an April now (not yet this year)', () => {
    expect(ageFromBirthday({ year: 2000, month: 12, day: 31 }, NOW)).toBe(25);
  });
});

describe('resolveYearFromAge', () => {
  it('round-trips for a birthday already passed this year', () => {
    const year = resolveYearFromAge(7, 1, 3, NOW);
    expect(year).toBe(2019);
    expect(ageFromBirthday({ year, month: 1, day: 3 }, NOW)).toBe(7);
  });

  it('round-trips for a birthday not yet reached this year', () => {
    // 7 years old with an 18 April birthday means they were born in 2018,
    // not 2019 — the naive currentYear - age is off by one here.
    const year = resolveYearFromAge(7, 4, 18, NOW);
    expect(year).toBe(2018);
    expect(ageFromBirthday({ year, month: 4, day: 18 }, NOW)).toBe(7);
  });

  it('round-trips on the birthday itself', () => {
    const year = resolveYearFromAge(7, 4, 17, NOW);
    expect(year).toBe(2019);
    expect(ageFromBirthday({ year, month: 4, day: 17 }, NOW)).toBe(7);
  });

  it('round-trips for age 0 (a baby born earlier this year)', () => {
    const year = resolveYearFromAge(0, 1, 3, NOW);
    expect(year).toBe(2026);
    expect(ageFromBirthday({ year, month: 1, day: 3 }, NOW)).toBe(0);
  });
});

describe('parseBirthday', () => {
  it('parses ISO format', () => {
    const r = parseBirthday('1992-04-17', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.month).toBe(4);
      expect(r.day).toBe(17);
      expect(r.hasYear).toBe(true);
      expect(r.date.getUTCFullYear()).toBe(1992);
    }
  });

  it('parses day-first slash format with year', () => {
    const r = parseBirthday('17/04/1992', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.month).toBe(4);
      expect(r.day).toBe(17);
      expect(r.hasYear).toBe(true);
    }
  });

  it('parses 2-digit years', () => {
    const r = parseBirthday('17/04/92', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.date.getUTCFullYear()).toBe(1992);
  });

  it('parses day-first slash without year', () => {
    const r = parseBirthday('17/04', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.month).toBe(4);
      expect(r.day).toBe(17);
      expect(r.hasYear).toBe(false);
    }
  });

  it('parses word month with day first', () => {
    const r = parseBirthday('17 April', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.month).toBe(4);
      expect(r.day).toBe(17);
      expect(r.hasYear).toBe(false);
    }
  });

  it('parses word month with year', () => {
    const r = parseBirthday('17 April 1992', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hasYear).toBe(true);
  });

  it('parses month-first word format', () => {
    const r = parseBirthday('April 17 1992', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.month).toBe(4);
      expect(r.day).toBe(17);
    }
  });

  it('is case-insensitive for month names', () => {
    expect(parseBirthday('17 APRIL', NOW).ok).toBe(true);
    expect(parseBirthday('17 apr', NOW).ok).toBe(true);
  });

  it('rejects garbage', () => {
    expect(parseBirthday('banana', NOW).ok).toBe(false);
    expect(parseBirthday('', NOW).ok).toBe(false);
    expect(parseBirthday('soon', NOW).ok).toBe(false);
  });

  it('rejects invalid calendar dates', () => {
    const r = parseBirthday('31 Feb 2020', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });

  it('accepts year-less 29 Feb (leap-year babies) — sentinel year must be a leap year', () => {
    const r = parseBirthday('29 Feb', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.month).toBe(2);
      expect(r.day).toBe(29);
      expect(r.hasYear).toBe(false);
      // The yearless date round-trips: getUTCDate stays 29, not rolled to 1 Mar.
      expect(r.date.getUTCMonth()).toBe(1);
      expect(r.date.getUTCDate()).toBe(29);
    }
  });

  it('accepts 29 Feb on a real leap year and rejects it on a non-leap year', () => {
    expect(parseBirthday('29 Feb 2024', NOW).ok).toBe(true);
    const nonLeap = parseBirthday('29 Feb 2023', NOW);
    expect(nonLeap.ok).toBe(false);
    if (!nonLeap.ok) expect(nonLeap.reason).toBe('invalid');
  });

  it('still rejects year-less 30 Feb and 31 Feb', () => {
    expect(parseBirthday('30 Feb', NOW).ok).toBe(false);
    expect(parseBirthday('31 Feb', NOW).ok).toBe(false);
  });

  it('rejects future dates with year', () => {
    const r = parseBirthday('2030-04-17', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('future');
  });

  it('does not reject yearless dates as future', () => {
    // "17 April" with the YEAR_UNKNOWN sentinel year is never future
    expect(parseBirthday('17 April', NOW).ok).toBe(true);
  });
});

describe('formatBirthday', () => {
  it('omits year when not provided', () => {
    const r = parseBirthday('17 April', NOW);
    if (!r.ok) throw new Error('parse failed');
    expect(formatBirthday(r.date, r.hasYear)).toBe('17 April');
  });

  it('includes year when provided', () => {
    const r = parseBirthday('1992-04-17', NOW);
    if (!r.ok) throw new Error('parse failed');
    expect(formatBirthday(r.date, r.hasYear)).toBe('17 April 1992');
  });
});

// 260615-osa — one-step add: deterministic name + birthday splitter (no LLM).
describe('splitNameAndBirthday', () => {
  it('trailing date, single-word name: "Sarah 3 March"', () => {
    const r = splitNameAndBirthday('Sarah 3 March', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('Sarah');
      expect(r.month).toBe(3);
      expect(r.day).toBe(3);
      expect(r.hasYear).toBe(false);
      expect(r.year).toBeNull();
    }
  });

  it('trailing slash date with year: "John 17/04/1992"', () => {
    const r = splitNameAndBirthday('John 17/04/1992', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('John');
      expect(r.month).toBe(4);
      expect(r.day).toBe(17);
      expect(r.hasYear).toBe(true);
      expect(r.year).toBe(1992);
    }
  });

  it('multi-word name + full date: "Mary Jane 3 March 1990"', () => {
    const r = splitNameAndBirthday('Mary Jane 3 March 1990', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('Mary Jane');
      expect(r.month).toBe(3);
      expect(r.day).toBe(3);
      expect(r.year).toBe(1990);
    }
  });

  it('month-first date: "Mom March 3"', () => {
    const r = splitNameAndBirthday('Mom March 3', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('Mom');
      expect(r.month).toBe(3);
      expect(r.day).toBe(3);
    }
  });

  it('strips a comma between name and date: "Sarah, 3 March"', () => {
    const r = splitNameAndBirthday('Sarah, 3 March', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe('Sarah');
  });

  it('leading date fallback: "3 March Sarah"', () => {
    const r = splitNameAndBirthday('3 March Sarah', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('Sarah');
      expect(r.month).toBe(3);
      expect(r.day).toBe(3);
    }
  });

  it('no date → ok:false', () => {
    expect(splitNameAndBirthday('just a name', NOW).ok).toBe(false);
  });

  it('single token → ok:false (need name AND date)', () => {
    expect(splitNameAndBirthday('Sarah', NOW).ok).toBe(false);
  });

  it('date only, no name → ok:false', () => {
    expect(splitNameAndBirthday('3 March', NOW).ok).toBe(false);
  });
});

// 260830-glz (WS2) — isDateToken went from private to exported so
// looksLikeBareName (add-circle.ts) reuses the splitter's own date signal.
describe('260830-glz: isDateToken', () => {
  it('digit-bearing tokens are date tokens', () => {
    expect(isDateToken('3')).toBe(true);
    expect(isDateToken('17/04/1992')).toBe(true);
  });

  it('month words are date tokens, punctuation and case tolerant', () => {
    expect(isDateToken('march')).toBe(true);
    expect(isDateToken('March,')).toBe(true);
  });

  it('a plain name is not a date token', () => {
    expect(isDateToken('John')).toBe(false);
  });
});

// 260903-ek8 (A5) — cleanPersonName gated on /[a-zA-Z]/, so a non-Latin name
// plus a valid date parsed as "not a name + birthday" and dead-ended.
describe('260903-ek8 (A5): splitNameAndBirthday accepts non-Latin-script names', () => {
  it('accepts a Chinese name', () => {
    const r = splitNameAndBirthday('李小龙 14 Sep 1995', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe('李小龙');
  });

  it('accepts a Cyrillic name', () => {
    const r = splitNameAndBirthday('Владимир 3 March 1990', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe('Владимир');
  });
});
