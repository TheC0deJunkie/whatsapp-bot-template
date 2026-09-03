// 260616-glb — Pure WhatsApp error-code map. No external deps.
// Known codes sourced from Twilio/Meta error documentation.
// isPenaltySignal=true codes indicate Meta quality/throttling penalties —
// a spike in these is a proxy for degraded sender reputation.

export interface WhatsAppErrorInfo {
  reason: string;
  isPenaltySignal: boolean;
}

const CODES: Record<string, WhatsAppErrorInfo> = {
  '63016': { reason: 'Message outside 24-hour customer-service window', isPenaltySignal: true },
  '131047': { reason: 'Re-engagement template rate limit exceeded', isPenaltySignal: true },
  '131049': { reason: 'Per-user marketing message limit reached (Meta cap)', isPenaltySignal: true },
  '131026': { reason: 'Message undeliverable (invalid number or unreachable)', isPenaltySignal: false },
  '131050': { reason: 'User has stopped marketing messages from this number', isPenaltySignal: false },
  '63024': { reason: 'Message failed to send — Twilio internal error', isPenaltySignal: false },
  '21610': { reason: 'Message to unsubscribed recipient', isPenaltySignal: false },
};

const UNKNOWN: WhatsAppErrorInfo = { reason: 'Unknown error', isPenaltySignal: false };

export function lookupErrorCode(code: string | null | undefined): WhatsAppErrorInfo {
  if (!code) return UNKNOWN;
  return CODES[code] ?? UNKNOWN;
}

export const WHATSAPP_ERROR_CODES = CODES;
