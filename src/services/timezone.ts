import { DateTime } from 'luxon';

// IANA timezone helpers. User.timezone is nullable; resolution falls back to
// env DEFAULT_TIMEZONE, then finally UTC.

export function defaultTimezone(): string {
  return process.env.DEFAULT_TIMEZONE || 'UTC';
}

export function resolveTimezone(userTimezone: string | null | undefined): string {
  return userTimezone || defaultTimezone();
}

export function isValidTimezone(tz: string): boolean {
  return DateTime.now().setZone(tz).isValid;
}

// ── Phone country code → IANA timezone (best-effort) ─────────────
//
// connections-no-birthday-events-260615 / timezone-nulls: most users never set
// a timezone (User.timezone null → DEFAULT_TIMEZONE = Africa/Johannesburg), so
// anyone abroad gets reminders on SA time. We infer a timezone from the E.164
// calling code at signup. Single-timezone countries are exact; multi-timezone
// countries (US/CA/AU/RU/BR…) use the most-populous representative zone — a
// rough guess that is still far closer than the SA default, and the user can
// correct it in profile. Returns null for unknown codes (caller keeps null →
// DEFAULT). Longest-prefix wins (codes are 1–4 digits).
const CODE_TO_TZ: Array<[string, string]> = [
  // 4-digit
  ['1242', 'America/Nassau'],
  // 3-digit — Africa (the active region)
  ['263', 'Africa/Harare'], // Zimbabwe
  ['260', 'Africa/Lusaka'], // Zambia
  ['267', 'Africa/Gaborone'], // Botswana
  ['264', 'Africa/Windhoek'], // Namibia
  ['258', 'Africa/Maputo'], // Mozambique
  ['265', 'Africa/Blantyre'], // Malawi
  ['266', 'Africa/Maseru'], // Lesotho
  ['268', 'Africa/Mbabane'], // Eswatini
  ['254', 'Africa/Nairobi'], // Kenya
  ['255', 'Africa/Dar_es_Salaam'], // Tanzania
  ['256', 'Africa/Kampala'], // Uganda
  ['250', 'Africa/Kigali'], // Rwanda
  ['234', 'Africa/Lagos'], // Nigeria
  ['233', 'Africa/Accra'], // Ghana
  ['251', 'Africa/Addis_Ababa'], // Ethiopia
  ['212', 'Africa/Casablanca'], // Morocco
  ['213', 'Africa/Algiers'], // Algeria
  ['216', 'Africa/Tunis'], // Tunisia
  ['230', 'Indian/Mauritius'], // Mauritius
  // 3-digit — rest
  ['971', 'Asia/Dubai'], // UAE
  ['966', 'Asia/Riyadh'], // Saudi Arabia
  ['974', 'Asia/Qatar'], // Qatar
  ['353', 'Europe/Dublin'], // Ireland
  ['351', 'Europe/Lisbon'], // Portugal
  ['852', 'Asia/Hong_Kong'], // Hong Kong
  ['880', 'Asia/Dhaka'], // Bangladesh
  // 2-digit
  ['27', 'Africa/Johannesburg'], // South Africa
  ['44', 'Europe/London'], // UK
  ['33', 'Europe/Paris'], // France
  ['49', 'Europe/Berlin'], // Germany
  ['39', 'Europe/Rome'], // Italy
  ['34', 'Europe/Madrid'], // Spain
  ['31', 'Europe/Amsterdam'], // Netherlands
  ['41', 'Europe/Zurich'], // Switzerland
  ['46', 'Europe/Stockholm'], // Sweden
  ['47', 'Europe/Oslo'], // Norway
  ['48', 'Europe/Warsaw'], // Poland
  ['43', 'Europe/Vienna'], // Austria
  ['32', 'Europe/Brussels'], // Belgium
  ['30', 'Europe/Athens'], // Greece
  ['90', 'Europe/Istanbul'], // Turkey
  ['20', 'Africa/Cairo'], // Egypt
  ['91', 'Asia/Kolkata'], // India
  ['92', 'Asia/Karachi'], // Pakistan
  ['86', 'Asia/Shanghai'], // China
  ['81', 'Asia/Tokyo'], // Japan
  ['82', 'Asia/Seoul'], // South Korea
  ['65', 'Asia/Singapore'], // Singapore
  ['60', 'Asia/Kuala_Lumpur'], // Malaysia
  ['63', 'Asia/Manila'], // Philippines
  ['62', 'Asia/Jakarta'], // Indonesia
  ['66', 'Asia/Bangkok'], // Thailand
  ['64', 'Pacific/Auckland'], // New Zealand
  ['55', 'America/Sao_Paulo'], // Brazil (representative)
  ['54', 'America/Argentina/Buenos_Aires'], // Argentina
  ['52', 'America/Mexico_City'], // Mexico (representative)
  ['61', 'Australia/Sydney'], // Australia (representative)
  ['7', 'Europe/Moscow'], // Russia/Kazakhstan (representative)
  // 1-digit
  ['1', 'America/New_York'], // US/Canada (representative — Eastern)
];

/**
 * Best-effort IANA timezone from an E.164 phone number's calling code.
 * Returns null for unknown codes (caller should leave User.timezone null so the
 * DEFAULT applies). Multi-timezone countries return a representative zone.
 */
export function timezoneFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '');
  if (!digits) return null;
  // Longest matching calling code wins.
  let best: string | null = null;
  let bestLen = 0;
  for (const [code, tz] of CODE_TO_TZ) {
    if (digits.startsWith(code) && code.length > bestLen) {
      best = tz;
      bestLen = code.length;
    }
  }
  return best;
}
