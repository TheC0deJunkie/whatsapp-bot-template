/**
 * Phone number normalization utilities.
 * Extracted from the production bot's helpers.ts.
 */

/** Strip "whatsapp:" prefix that Twilio prepends */
export function stripWhatsAppPrefix(raw: string): string {
  return raw.replace(/^whatsapp:/i, '').trim();
}

/**
 * Best-effort conversion to E.164 format.
 * Handles common patterns: leading 0 (South Africa), no plus sign, etc.
 * Extend the country rules for your region.
 */
export function toE164(raw: string, defaultCountryCode = '27'): string {
  let n = raw.replace(/[\s\-()]/g, '');

  // Already E.164
  if (/^\+\d{10,15}$/.test(n)) return n;

  // Has plus but messy
  if (n.startsWith('+')) {
    n = '+' + n.replace(/\D/g, '');
    return n;
  }

  const digits = n.replace(/\D/g, '');

  // 260903-ek8 (A6) — a leading "00" is the INTERNATIONAL dialing prefix, not a
  // national trunk zero: the digits after it already carry their own country
  // code. This must run BEFORE the single-leading-zero branch below, which
  // would otherwise strip one zero and prepend defaultCountryCode on top of the
  // country code already present ("00 27 82 123 4567" → "+27027821234567").
  // No valid SA subscriber number starts with a double zero, so this is
  // unambiguous.
  if (digits.startsWith('00') && digits.length > 2) {
    return `+${digits.slice(2)}`;
  }

  // Strip leading zeros and prepend country code
  if (digits.startsWith('0')) {
    return `+${defaultCountryCode}${digits.slice(1)}`;
  }

  // Already has country code without plus
  if (digits.length >= 10) {
    return `+${digits}`;
  }

  // Fallback: prepend country code
  return `+${defaultCountryCode}${digits}`;
}

/** Full normalization: strip prefix → E.164 */
export function normalizePhone(
  raw: string,
  defaultCountryCode = '27',
): string {
  return toE164(stripWhatsAppPrefix(raw), defaultCountryCode);
}

/**
 * 260830-ehs-fix — phone DETECTION must run on the RAW text.
 *
 * normalizePhone/toE164 is a COERCER, not a detector: it strips letters and
 * falls back to prepending the default country code, so
 * `"Test Melons 23 September 1967"` → digits `231967` → `"+27231967"`, which
 * passes a `/^\+\d{8,15}$/` shape test. Using normalizePhone as a discriminator
 * therefore read a birthday as a phone number on the live bot (2026-08-30) and
 * sent the giver an invite instead of saving the person.
 *
 * A phone-shaped message carries NO letters, only digits and phone punctuation,
 * and 9–15 digits (SA local `0821234567` = 10, E.164 `+27821234567` = 11).
 * Callers should test this FIRST, then normalizePhone the value they accepted.
 */
export function looksLikePhone(raw: string): boolean {
  const trimmed = stripWhatsAppPrefix(raw ?? '');
  if (!trimmed) return false;
  if (/[A-Za-z]/.test(trimmed)) return false;
  if (!/^\+?[\d\s\-()]+$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15;
}

/**
 * Log-safe rendering of a phone: keeps the country code and the last 3 digits,
 * masks the rest — `+27824029781` → `+27••••••781`. Enough to correlate log
 * lines for one user (prefix + suffix are stable) without writing a dialable
 * number into Vercel/Sentry logs. Never used for persisted data.
 *
 * Country-code guess: for a `+` number, take 2 digits (SA and most of the
 * typical countries; a 1-/3-digit code just masks slightly more or
 * less — still not dialable). Non-E.164 input is normalized first so the
 * output shape is uniform. Empty/garbage → '(no phone)'.
 */
export function maskPhone(raw: string | null | undefined): string {
  if (!raw) return '(no phone)';
  const e164 = normalizePhone(String(raw));
  const digits = e164.replace(/\D/g, '');
  if (digits.length < 6) return '(masked)';
  const cc = digits.slice(0, 2);
  const tail = digits.slice(-3);
  const hidden = digits.length - cc.length - tail.length;
  return `+${cc}${'•'.repeat(hidden)}${tail}`;
}
