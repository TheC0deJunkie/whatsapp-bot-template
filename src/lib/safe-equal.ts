// Constant-time string equality for secrets (webhook signatures, shared
// secrets, owner tokens). Wraps crypto.timingSafeEqual with the length guard it
// needs — timingSafeEqual THROWS on unequal-length buffers, which would turn a
// short/garbage input into a 500 instead of a clean "no match".
//
// The length comparison itself is not constant-time, but leaking the length of
// a HMAC digest / random token is not a useful oracle: every legitimate value
// has a fixed, public length. What matters is that no byte-by-byte early exit
// exists once lengths match.

import crypto from 'node:crypto';

/** True iff `a` and `b` are byte-identical (UTF-8). Never throws. */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
