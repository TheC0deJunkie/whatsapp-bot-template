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

  // Strip leading zeros and prepend country code
  const digits = n.replace(/\D/g, '');
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
