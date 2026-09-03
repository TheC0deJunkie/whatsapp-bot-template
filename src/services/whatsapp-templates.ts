// Twilio Content API template registry + approval-gate helpers.
//
// THE PATTERN (hard-won production lesson): outside WhatsApp's 24-hour
// customer-service window, only PRE-APPROVED templates deliver — a free-form
// send silently fails. And "approved" alone is not enough: a template Meta
// approved can still fail at send time (e.g. Twilio error 63028,
// parameter-count mismatch — see whatsapp-error-codes.ts). So:
//
//   1. Define templates in code (the registry below) — reviewable, versioned.
//   2. syncTemplates() provisions them on Twilio + submits for Meta approval.
//      Idempotent — safe to run from a script or on startup.
//   3. At send time call getContentTemplate(name, auth):
//        status 'approved' → provider.sendContentTemplate(to, sid, vars)
//        anything else     → free-form fallback (inside the 24h window) or
//                            mark the send pending and retry on a later tick.
//   4. Gate on LIVE-verified status, never on a cached "it was approved once".
//
// Content-type notes (Twilio Content API):
//   - twilio/text            approvable; sends outside the 24h window.
//   - twilio/quick-reply     approvable UNLESS inSessionOnly (in-window menus
//                            need no approval — submitting wastes review cycles).
//   - twilio/list-picker     NOT eligible for WhatsApp approval (HTTP 400 from
//                            the Approval API) — create-only, in-window sends.
//   - twilio/card            approvable; same inSessionOnly escape hatch.

export interface TwilioAuth {
  accountSid: string;
  authToken: string;
}

export interface TemplateDef {
  /** Lowercase alphanumeric + underscores — WhatsApp template name constraint. */
  name: string;
  friendlyName: string;
  /** Body with {{1}}-style variables. */
  body: string;
}

export interface QuickReplyAction {
  type: 'QUICK_REPLY';
  title: string;
  id: string;
}

export interface ListPickerItem {
  id: string;
  item: string;
  description?: string;
}

export interface QuickReplyDef extends TemplateDef {
  kind: 'twilio/quick-reply';
  actions: QuickReplyAction[];
  /** true → only ever sent inside the 24h window: created on Twilio but never
   *  submitted for Meta approval. */
  inSessionOnly?: boolean;
}

export interface ListPickerDef extends TemplateDef {
  kind: 'twilio/list-picker';
  button: string;
  items: ListPickerItem[];
}

export interface CardDef extends TemplateDef {
  kind: 'twilio/card';
  /** Card header text. Required by Meta ("Title is a required field"). ≤60 chars. */
  title: string;
  mediaUrl: string;
  actions: QuickReplyAction[];
  inSessionOnly?: boolean;
}

export type ContentTemplateDef = TemplateDef | QuickReplyDef | ListPickerDef | CardDef;

// ── Registry ─────────────────────────────────────────────────────────────────
// Add your templates here. Version the NAME (hello_v1 → hello_v2) when the
// body changes — Meta approval is per-content-resource, and edits reset it.

export const TEMPLATES: Record<string, ContentTemplateDef> = {
  // Approvable re-engagement text — the "outside the 24h window" workhorse.
  hello: {
    name: 'hello_v1',
    friendlyName: 'hello_v1',
    body: 'Hi {{1}} — you asked me to keep you posted about {{2}}. Reply *menu* to pick up where you left off.',
  },
};

/** Sample variable values shown to Meta reviewers at approval time. Give
 *  production-grade samples — reviewers reject templates whose stubs look
 *  like spam. Keyed by template NAME. */
export const VARIABLE_SAMPLES: Record<string, Record<string, string>> = {
  hello_v1: { '1': 'Alex', '2': 'your order' },
};

/** WhatsApp template category submitted to Meta. UTILITY fits transactional
 *  notifications; MARKETING is required for promotional content. */
const TEMPLATE_CATEGORY = 'UTILITY';

const CONTENT_BASE = 'https://content.twilio.com/v1';

// ── Approval status + cache ──────────────────────────────────────────────────

export type ApprovalStatus =
  | 'received'
  | 'approved'
  | 'rejected'
  | 'pending_deletion'
  | 'unknown';

interface CachedTemplate {
  sid: string;
  status: ApprovalStatus;
  checkedAt: number;
}

// Non-approved statuses are re-checked after this TTL so a template flipping
// to approved is picked up without a redeploy.
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CachedTemplate>();

function authHeader(auth: TwilioAuth): string {
  return 'Basic ' + Buffer.from(`${auth.accountSid}:${auth.authToken}`).toString('base64');
}

async function listAllContent(
  auth: TwilioAuth,
): Promise<Array<{ sid: string; friendly_name: string }>> {
  const out: Array<{ sid: string; friendly_name: string }> = [];
  let url: string | null = `${CONTENT_BASE}/Content?PageSize=200`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: authHeader(auth) } });
    if (!res.ok) throw new Error(`Content list failed: HTTP ${res.status}`);
    const json: any = await res.json();
    for (const c of json.contents ?? []) out.push({ sid: c.sid, friendly_name: c.friendly_name });
    url = json.meta?.next_page_url ?? null;
  }
  return out;
}

/** Build the per-def `types` payload for a Content API create body. */
function buildTypesPayload(def: ContentTemplateDef): Record<string, unknown> {
  if ('kind' in def) {
    if (def.kind === 'twilio/quick-reply') {
      return { 'twilio/quick-reply': { body: def.body, actions: def.actions } };
    }
    if (def.kind === 'twilio/list-picker') {
      return { 'twilio/list-picker': { body: def.body, button: def.button, items: def.items } };
    }
    if (def.kind === 'twilio/card') {
      return {
        'twilio/card': {
          title: def.title,
          body: def.body,
          media: [def.mediaUrl],
          actions: def.actions,
        },
      };
    }
  }
  return { 'twilio/text': { body: def.body } };
}

async function createContent(
  auth: TwilioAuth,
  def: ContentTemplateDef,
  variableSamples?: Record<string, string>,
): Promise<string> {
  const res = await fetch(`${CONTENT_BASE}/Content`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(auth),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      friendly_name: def.friendlyName,
      language: 'en',
      variables: variableSamples ?? { '1': 'Alex' },
      types: buildTypesPayload(def),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Content create failed (${def.name}): HTTP ${res.status} ${text}`);
  }
  const json: any = await res.json();
  return json.sid;
}

async function submitApproval(
  auth: TwilioAuth,
  sid: string,
  def: ContentTemplateDef,
): Promise<void> {
  const res = await fetch(`${CONTENT_BASE}/Content/${sid}/ApprovalRequests/whatsapp`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(auth),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: def.name, category: TEMPLATE_CATEGORY }),
  });
  // 409 = already submitted — idempotency, not an error.
  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    throw new Error(`Approval submit failed (${def.name}): HTTP ${res.status} ${text}`);
  }
}

export async function fetchApprovalStatus(
  auth: TwilioAuth,
  sid: string,
): Promise<ApprovalStatus> {
  const res = await fetch(`${CONTENT_BASE}/Content/${sid}/ApprovalRequests`, {
    headers: { Authorization: authHeader(auth) },
  });
  if (!res.ok) return 'unknown';
  const json: any = await res.json();
  return (json.whatsapp?.status as ApprovalStatus) ?? 'unknown';
}

function needsApproval(def: ContentTemplateDef): boolean {
  if ('kind' in def) {
    if (def.kind === 'twilio/list-picker') return false; // never approvable
    if ((def.kind === 'twilio/quick-reply' || def.kind === 'twilio/card') && def.inSessionOnly) {
      return false;
    }
  }
  return true;
}

export interface SyncSummary {
  synced: number;
  created: number;
  approved: number;
  pending: number;
  /** Resilient sync: defs whose provisioning threw. The loop records the name
   *  + error and CONTINUES so one bad template can't block the others. */
  failed: Array<{ name: string; error: string }>;
}

/**
 * Provision every registry template on Twilio and (where eligible) submit it
 * for Meta approval. Idempotent — safe to run on every deploy or from a
 * one-off script. Caches (sid, status) for send-time lookups.
 */
export async function syncTemplates(auth: TwilioAuth): Promise<SyncSummary> {
  const summary: SyncSummary = { synced: 0, created: 0, approved: 0, pending: 0, failed: [] };
  const existing = await listAllContent(auth);
  const byFriendlyName = new Map(existing.map((c) => [c.friendly_name, c.sid]));

  for (const def of Object.values(TEMPLATES)) {
    try {
      let sid = byFriendlyName.get(def.friendlyName);
      if (!sid) {
        sid = await createContent(auth, def, VARIABLE_SAMPLES[def.name]);
        if (needsApproval(def)) await submitApproval(auth, sid, def);
        summary.created++;
      }
      const status = await fetchApprovalStatus(auth, sid);
      cache.set(def.name, { sid, status, checkedAt: Date.now() });
      summary.synced++;
      if (status === 'approved') summary.approved++;
      else summary.pending++;
    } catch (err: any) {
      summary.failed.push({ name: def.name, error: err?.message ?? 'unknown' });
      console.error(`[templates] sync failed for ${def.name}:`, err);
    }
  }
  return summary;
}

/**
 * Send-time lookup: registry name → live { sid, status }, or null when the
 * template isn't in the registry / isn't provisioned on Twilio. Callers MUST
 * branch on status === 'approved' and fall back to a free-form send otherwise.
 *
 * Cold-cache self-warm: on a serverless instance the sync may never have run
 * in THIS process, so a cold cache resolves live once (one list sweep + one
 * status fetch) and then short-circuits. Non-approved cache entries re-check
 * after APPROVAL_TTL_MS so approvals are picked up without a redeploy.
 */
export async function getContentTemplate(
  name: string,
  auth: TwilioAuth,
): Promise<{ sid: string; status: ApprovalStatus } | null> {
  const def = Object.values(TEMPLATES).find((d) => d.name === name);
  if (!def) return null;

  const cached = cache.get(def.name);
  if (cached) {
    if (cached.status !== 'approved' && Date.now() - cached.checkedAt > APPROVAL_TTL_MS) {
      const fresh = await fetchApprovalStatus(auth, cached.sid);
      cache.set(def.name, { sid: cached.sid, status: fresh, checkedAt: Date.now() });
      return { sid: cached.sid, status: fresh };
    }
    return { sid: cached.sid, status: cached.status };
  }

  try {
    const existing = await listAllContent(auth);
    const match = existing.find((c) => c.friendly_name === def.friendlyName);
    if (!match) return null; // genuinely not provisioned on Twilio
    const status = await fetchApprovalStatus(auth, match.sid);
    cache.set(def.name, { sid: match.sid, status, checkedAt: Date.now() });
    return { sid: match.sid, status };
  } catch (err) {
    console.error('[templates] getContentTemplate live-lookup failed:', err);
    return null; // log-and-continue — caller falls back to free-form send
  }
}
