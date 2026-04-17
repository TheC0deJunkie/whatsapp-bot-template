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

  /** Validate incoming webhook signature. Return true if valid. */
  validateWebhook(req: IncomingRequest): boolean;

  /** Parse raw webhook body into normalized IncomingMessage. Return null to skip. */
  parseWebhook(req: IncomingRequest): IncomingMessage | null;
}

// ── Store Adapter ─────────────────────────────────────────────
export interface DurableFields {
  botStatus?: string;
  lastMenu?: MenuButton[] | null;
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
}

// ── Incoming Message (normalized from any provider) ───────────
export interface IncomingMessage {
  /** E.164 phone number */
  from: string;
  /** Raw text body */
  body: string;
  /** Button ID if interactive reply */
  buttonPayload: string;
  /** True if this is a delivery status callback, not a user message */
  isStatusCallback: boolean;
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
