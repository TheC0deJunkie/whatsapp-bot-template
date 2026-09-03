// Birthday date parsing.
//
// Accepts: "1992-04-17", "17 April 1992", "17 April", "17/04/1992", "17/04"
// South-African day-first convention for slashes (DD/MM, not MM/DD).
// Year is optional — if missing we store month+day only (year = YEAR_UNKNOWN sentinel).
// Returned Date is anchored at 12:00 UTC to avoid TZ drift across SAST/UTC.

export type ParsedBirthday =
  | { ok: true; date: Date; month: number; day: number; hasYear: boolean }
  | { ok: false; reason: 'unparseable' | 'future' | 'invalid' };

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

// Sentinel year stamped on year-less birthdays. MUST be a leap year so
// "29 Feb" (leap-year babies) round-trips through buildDate — 1900 is NOT a
// leap year (÷100, not ÷400). 1904 is leap and still an impossible birth
// year (~122y), preserving the "no real user collides with the sentinel"
// property that events.ts relies on for sentinel detection.
export const YEAR_UNKNOWN = 1904;

function buildDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  // Reject invalid day/month combos (e.g. Feb 30)
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

// Whole years between dob and now, UTC-anchored (matches parseBirthday's
// 12:00 UTC convention). Used by the onboarding/profile age gate (13+).
export function ageInYears(dob: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

// 260816-eky — month/day-accurate age from stored Event/User birthday parts.
// Replaces the `currentYear - year` shorthand that was scattered around the
// gift paths: that shorthand over-states the age by one for anyone whose
// birthday hasn't happened yet this year, which is exactly the window in which
// gift ideas matter most.
export function ageFromBirthday(
  birthday: { year: number; month: number; day: number },
  now: Date = new Date(),
): number {
  const dob = new Date(Date.UTC(birthday.year, birthday.month - 1, birthday.day, 12, 0, 0));
  return ageInYears(dob, now);
}

// Inverse of ageFromBirthday: given "they are N years old" plus their known
// month/day, derive the birth year. Round-trips through ageFromBirthday rather
// than re-deriving the has-the-birthday-passed comparison by hand.
export function resolveYearFromAge(
  age: number,
  month: number,
  day: number,
  now: Date = new Date(),
): number {
  const year = now.getUTCFullYear() - age;
  return ageFromBirthday({ year, month, day }, now) === age ? year : year - 1;
}

export function parseBirthday(input: string, now: Date = new Date()): ParsedBirthday {
  const raw = input.trim().toLowerCase();
  if (!raw) return { ok: false, reason: 'unparseable' };

  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;

  // 1. ISO: 1992-04-17
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    year = parseInt(iso[1], 10);
    month = parseInt(iso[2], 10);
    day = parseInt(iso[3], 10);
  }

  // 2. Slashes: 17/04/1992 or 17/04 (day-first)
  if (!iso) {
    const slash = raw.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?$/);
    if (slash) {
      day = parseInt(slash[1], 10);
      month = parseInt(slash[2], 10);
      if (slash[3]) {
        let y = parseInt(slash[3], 10);
        if (y < 100) y += y < 30 ? 2000 : 1900;
        year = y;
      }
    }
  }

  // 3. Word month: "17 April", "17 April 1992", "April 17", "April 17 1992"
  if (month === null) {
    const words = raw.replace(/,/g, '').split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 3) {
      const numericTokens = words.filter((w) => /^\d{1,4}$/.test(w));
      const monthToken = words.find((w) => w in MONTHS);
      if (monthToken && numericTokens.length >= 1) {
        month = MONTHS[monthToken];
        // day = the 1- or 2-digit number; year = the 4-digit number
        for (const n of numericTokens) {
          const v = parseInt(n, 10);
          if (n.length <= 2) day = v;
          else if (n.length === 4) year = v;
        }
      }
    }
  }

  if (month === null || day === null) {
    return { ok: false, reason: 'unparseable' };
  }

  const hasYear = year !== null;
  const builtYear = year ?? YEAR_UNKNOWN;
  const date = buildDate(builtYear, month, day);
  if (!date) return { ok: false, reason: 'invalid' };

  // Reject future dates only when a real year was supplied.
  // (Year-less "17 April" with the YEAR_UNKNOWN sentinel is never "future".)
  if (hasYear && date.getTime() > now.getTime()) {
    return { ok: false, reason: 'future' };
  }

  return { ok: true, date, month, day, hasYear };
}

// 260615-osa — one-step add: split a single free-text reply into a name + a
// birthday WITHOUT an LLM (no Gemini quota). Strategy: scan for a date span,
// preferring the TRAILING tokens (people write "Sarah 3 March"), then the
// leading tokens as a fallback ("3 March Sarah"). The non-date remainder is the
// name. Longest-first trailing span so "Sarah 3 March 1990" grabs the full date.
// Deterministic + guided-prompt (msgAskNameAndBirthday shows the format); a miss
// returns ok:false so the caller can reprompt. Same interface a future Gemini
// extractor could implement.
// 260626 — one-step add now also captures an OPTIONAL relationship typed in the
// same message ("Sarah 3 March sister"). relationship is null when the reply is
// just name + date, so the manual flow never needs a second prompt.
export type NameBirthday =
  | { ok: true; name: string; month: number; day: number; hasYear: boolean; year: number | null; relationship: string | null }
  | { ok: false };

function cleanPersonName(s: string): string {
  const c = s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, '')
    .slice(0, 60);
  // 260903-ek8 (A5) — any Unicode letter, not just a-zA-Z. The old gate made a
  // Chinese / Arabic / Cyrillic name unparseable as a name + birthday, so those
  // users could never be added at all. Digit-only and emoji-only input still
  // fails this test and is still refused.
  if (!c || !/\p{L}/u.test(c)) return '';
  return c;
}

// Relationship label: same cleanup as a name (strip stray punctuation/commas the
// user puts between the date and the label), capped, returns null when empty.
function cleanRelationship(s: string): string | null {
  const c = s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, '')
    .slice(0, 60);
  if (!c || !/[a-zA-Z]/.test(c)) return null;
  return c;
}

function toNameBirthday(
  name: string,
  parsed: ParsedBirthday,
  relationship: string | null = null,
): NameBirthday | null {
  if (!parsed.ok) return null;
  const cleaned = cleanPersonName(name);
  if (!cleaned) return null;
  return {
    ok: true,
    name: cleaned,
    month: parsed.month,
    day: parsed.day,
    hasYear: parsed.hasYear,
    year: parsed.hasYear ? parsed.date.getUTCFullYear() : null,
    relationship,
  };
}

// A token belongs to the date span if it carries a digit (e.g. "3", "17/04/1992",
// "1990-03-17") or is a month word ("March", "march,"). Used to fence the date
// off from a trailing relationship label, which parseBirthday would otherwise
// silently absorb (it scans for a day+month anywhere in its input).
// 260830-glz (WS2) — exported so add-circle.ts's looksLikeBareName reuses the
// EXACT date-signal check the splitter uses (no second implementation to drift).
export function isDateToken(tok: string): boolean {
  if (/\d/.test(tok)) return true;
  return tok.toLowerCase().replace(/[^a-z]/g, '') in MONTHS;
}

export function splitNameAndBirthday(input: string, now: Date = new Date()): NameBirthday {
  const tokens = input.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (tokens.length < 2) return { ok: false }; // need a name AND a date

  // Primary: locate the FIRST contiguous run of date tokens. The name is
  // everything before it; an OPTIONAL relationship is everything after it
  // ("Sarah 3 March sister" → name Sarah, date 3 March, relationship sister).
  // Fencing the run explicitly keeps a trailing label out of the date candidate.
  let runStart = -1;
  let runEnd = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (isDateToken(tokens[i])) {
      if (runStart === -1) runStart = i;
      runEnd = i + 1;
    } else if (runStart !== -1) {
      break; // first run only — later date-ish tokens are part of the label
    }
  }
  if (runStart > 0) {
    // ≥1 name token must sit before the date run.
    const parsed = parseBirthday(tokens.slice(runStart, runEnd).join(' '), now);
    const relationship = cleanRelationship(tokens.slice(runEnd).join(' '));
    const result = toNameBirthday(tokens.slice(0, runStart).join(' '), parsed, relationship);
    if (result) return result;
  }

  // Fallback: trailing- then leading-date span search (no relationship inferred).
  // Covers orders the run heuristic skips, e.g. leading date "3 March Sarah".
  for (let k = Math.min(4, tokens.length - 1); k >= 1; k--) {
    const result = toNameBirthday(
      tokens.slice(0, tokens.length - k).join(' '),
      parseBirthday(tokens.slice(tokens.length - k).join(' '), now),
    );
    if (result) return result;
  }
  for (let k = Math.min(4, tokens.length - 1); k >= 1; k--) {
    const result = toNameBirthday(
      tokens.slice(k).join(' '),
      parseBirthday(tokens.slice(0, k).join(' '), now),
    );
    if (result) return result;
  }
  return { ok: false };
}

// Human-friendly rendering for confirmation messages.
// "17 April" when year unknown, "17 April 1992" otherwise.
export function formatBirthday(date: Date, hasYear: boolean): string {
  const day = date.getUTCDate();
  const monthName = date.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  return hasYear ? `${day} ${monthName} ${date.getUTCFullYear()}` : `${day} ${monthName}`;
}
