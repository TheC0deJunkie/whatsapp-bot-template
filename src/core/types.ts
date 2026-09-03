// ── Message Result ─────────────────────────────────────────────
export interface MessageResult {
  ok: boolean;
  sid?: string;
  error?: string;
}

// ── Menu Button ───────────────────────────────────────────────
export interface MenuButton {
  id: string;
  title: string;
}

// ── Provider Adapter ──────────────────────────────────────────
export interface ProviderAdapter {
  /** Send a plain text message */
  sendText(to: string, body: string): Promise<MessageResult>;

  /** Send interactive buttons (rendered as numbered text list) */
  sendInteractive(
    to: string,
    bodyText: string,
    buttons: MenuButton[],
  ): Promise<MessageResult>;

  /** Send a message with media attachment */
  sendMedia(
    to: string,
    body: string,
    mediaUrl: string,
  ): Promise<MessageResult>;

  /** Send a pre-approved template message (provider-specific) */
  sendTemplate(
    to: string,
    templateId: string,
    variables?: Record<string, string>,
  ): Promise<MessageResult>;

  /** Send a pre-approved Content API template message by ContentSid
   *  (Twilio-specific). Mutually exclusive with Body — twilioSend MUST NOT
   *  include a Body param when ContentSid is present (HTTP 400 otherwise).
   *  Meta provider implements this as a stub that delegates to sendTemplate
   *  (no Content API SID concept on Cloud API). */
  sendContentTemplate(
    to: string,
    contentSid: string,
    contentVariables?: Record<string, string>,
  ): Promise<MessageResult>;

  /** Fetch provider-side delivery status for a previously sent message.
   *  Twilio status string: queued|sending|sent|delivered|read|failed|undelivered.
   *  Returns null when unknown / unsupported / on error. Optional — used to order
   *  a following message AFTER media has actually left the send queue (media has
   *  higher delivery latency than text, so a fixed sleep can't guarantee order).
   *  Providers without a status API simply omit this. (260615-ord2) */
  getMessageStatus?(sid: string): Promise<string | null>;

  /** Validate incoming webhook signature. Return true if valid. */
  validateWebhook(req: IncomingRequest): boolean;

  /** Parse raw webhook body into normalized IncomingMessage. Return null to skip. */
  parseWebhook(req: IncomingRequest): IncomingMessage | null;
}

// ── Store Adapter ─────────────────────────────────────────────
export interface DurableFields {
  botStatus?: string;
  lastMenu?: MenuButton[] | null;
  // Draft fields hold in-flight flow values so a serverless cold start
  // mid-flow doesn't wipe progress. To add one: a BotSession column, an
  // entry here, and a mapping in prisma-store get()/persist().
  draftFirstName?: string | null;
  draftSurname?: string | null;
  /** Last provider sender (E.164 of our receiving number) the user texted.
   *  Lets outbound cron jobs pin their `From` line per recipient. Persisted
   *  by the engine on every inbound turn. */
  lastSenderFrom?: string | null;
  [key: string]: unknown;
}

export interface StoreAdapter {
  /** Get conversation state for a session key */
  get(sessionId: string): Promise<Record<string, any>>;

  /** Set full conversation state in hot storage */
  set(sessionId: string, state: Record<string, any>): Promise<void>;

  /** Clear conversation state */
  clear(sessionId: string): Promise<void>;

  /** Persist durable fields to backing store (DB). No-op for pure in-memory. */
  persist(sessionId: string, fields: DurableFields): Promise<void>;
}

// ── Incoming Request (framework-agnostic) ─────────────────────
export interface IncomingRequest {
  body: Record<string, any>;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  originalUrl?: string;
  protocol?: string;
  /** HTTP method (GET/POST/etc.) — required for Meta webhook challenge handling */
  method?: string;
  /** Raw unparsed body string — required for Meta signature verification */
  rawBody?: string;
  /** Parsed query string parameters */
  query?: Record<string, string>;
}

// ── Incoming Message (normalized from any provider) ───────────
export interface IncomingMessage {
  /** E.164 phone number */
  from: string;
  /** E.164 phone (normalized) of OUR receiving number — i.e. which Twilio
   *  sender this inbound webhook hit. Populated by parseWebhook from req.body.To. */
  to?: string;
  /** Raw text body */
  body: string;
  /** Button ID if interactive reply */
  buttonPayload: string;
  /** True if this is a delivery status callback, not a user message */
  isStatusCallback: boolean;
  // 260616-glb — delivery-callback payload. Populated by parseWebhook only on
  // status-callback POSTs so the engine can upsert the MessageDelivery row.
  /** Twilio MessageSid the callback refers to */
  statusCallbackSid?: string;
  /** MessageStatus: queued|sent|delivered|read|failed|undelivered */
  statusCallbackStatus?: string;
  /** Twilio ErrorCode (string, may be absent) */
  statusCallbackErrorCode?: string;
  /** Twilio ErrorMessage human text (may be absent) */
  statusCallbackErrorMessage?: string;
  // 260617-toz — inbound idempotency dedup key.
  /** Twilio inbound MessageSid — populated by parseWebhook on the INBOUND
   *  branch only. Drives the engine's idempotency dedup gate (Step 3.5). */
  providerMessageSid?: string;
  /** Location data if user shared location */
  location?: { latitude: number; longitude: number };
  /** Media URL if user sent media */
  mediaUrl?: string;
  /** All raw fields from the webhook (for debugging) */
  rawFields?: Record<string, any>;
}

// ── Handler Context ───────────────────────────────────────────
export interface HandlerContext {
  /** Normalized phone number (E.164) */
  phone: string;
  /** Raw incoming message */
  message: IncomingMessage;
  /** Current session state (mutable — changes are saved after handler chain) */
  state: Record<string, any>;
  /** Resolved action after 5-layer pipeline */
  action: string;
  /** Raw text input (trimmed) */
  text: string;
  /** Lowercase text */
  textLower: string;
  /** Current botStatus from state */
  status: string;
  /** User record from lookupUser (your app's shape) */
  user: any;
  /** Provider adapter for sending messages */
  send: ProviderAdapter;
  /** Update botStatus and optionally other durable fields, then persist */
  setState(patch: DurableFields): Promise<void>;
  /** Store lastMenu buttons (for number-to-button resolution) and persist */
  setMenu(buttons: MenuButton[]): Promise<void>;
  /** Twilio Content API credentials for runtime template lookup
   *  (getContentTemplate). Null when env vars are absent — handlers MUST
   *  handle the null path with their existing free-form fallback. Set at the
   *  engine boundary from BotConfig.providerAuth (260528-hxb). */
  providerAuth?: { accountSid: string; authToken: string } | null;
}

// ── Handler Function ──────────────────────────────────────────
export type Handler = (ctx: HandlerContext) => Promise<boolean>;

// ── Global Command ────────────────────────────────────────────
export interface GlobalCommand {
  /** Pattern to match against lowercase text. Regex or string array. */
  match: RegExp | string[];
  /** Handle the command. Return true to stop processing. */
  handle: (ctx: HandlerContext) => Promise<boolean>;
}

// ── Bot Configuration ─────────────────────────────────────────
export interface BotConfig {
  /** Messaging provider adapter */
  provider: ProviderAdapter;
  /** State storage adapter */
  store: StoreAdapter;
  /** Twilio Content API credentials. Wired into ctx.providerAuth on every
   *  handler dispatch. Optional — handlers fall back to free-form sends when
   *  null (260528-hxb). */
  providerAuth?: { accountSid: string; authToken: string } | null;

  /** Session timeout in ms (default: 20 * 60 * 1000 = 20 min) */
  sessionTimeoutMs?: number;
  /** botStatus values that are "stateful" — subject to timeout reset */
  statefulStatuses: string[];

  /** Max identical messages before loop break (default: 3) */
  loopBreakerThreshold?: number;
  /** Loop breaker time window in ms (default: 2 * 60 * 1000 = 2 min) */
  loopBreakerWindowMs?: number;

  /** Global commands intercepted before handler dispatch */
  globalCommands: GlobalCommand[];
  /** Ordered handler chain — first to return true wins */
  handlers: Handler[];

  /** Look up a user from phone number. Return null/undefined if not found. */
  lookupUser: (phone: string) => Promise<any>;

  /**
   * Session key derivation. Defaults to phone number.
   * Override to use user.id, employee.id, etc.
   */
  sessionKey?: (phone: string, user: any) => string;

  /** Called when user is not found */
  onUnknownUser?: (phone: string, send: ProviderAdapter) => Promise<void>;
  /** Called when no handler matched (fallback) */
  onFallback?: (ctx: HandlerContext) => Promise<void>;
  /** Called when loop breaker triggers */
  onLoopBreak?: (ctx: HandlerContext) => Promise<void>;
  /** Called when session times out */
  onSessionTimeout?: (ctx: HandlerContext) => Promise<void>;

  /** Enable debug ring buffer + viewer/simulator routes */
  debug?: boolean;
}

// ── Webhook Response ──────────────────────────────────────────
export interface WebhookResponse {
  status: number;
  body?: string;
}

// ── Debug Entry ───────────────────────────────────────────────
export interface DebugEntry {
  ts: string;
  direction: 'inbound' | 'outbound';
  from: string;
  body: string;
  resolvedAction?: string;
  status?: string;
  allFields?: Record<string, unknown>;
}
