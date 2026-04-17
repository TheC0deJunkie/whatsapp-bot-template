# WhatsApp Menu Bot Template

A production-proven, provider-agnostic WhatsApp bot template with menu-based navigation, pluggable storage, and built-in debugging tools.

Extracted from a real production system handling thousands of conversations. The architecture, state machine, and reliability patterns are battle-tested.

## Quick Start

```bash
npm install
cp .env.example .env    # Fill in your credentials
npm run dev              # Start with hot reload
```

Open `http://localhost:3000/debug/simulator` to test the bot without Twilio.

## Architecture

```
Incoming Webhook
    ↓
┌─────────────────────────────┐
│  Engine (16-step pipeline)  │
│  ┌────────────────────────┐ │
│  │ 1. Validate signature  │ │
│  │ 2. Parse message       │ │
│  │ 3. Lookup user         │ │
│  │ 4. Load state          │ │
│  │ 5. Session timeout     │ │
│  │ 6. Loop breaker        │ │
│  │ 7. Global commands     │ │
│  │ 8. Action resolution   │ │
│  │ 9. Handler dispatch    │ │
│  │ 10. Fallback           │ │
│  └────────────────────────┘ │
└─────────────────────────────┘
    ↓
Provider Adapter → Twilio / WhatsApp Cloud API / etc.
```

### Key Patterns

- **Handler Chain**: Ordered array of async functions returning `boolean`. First to return `true` wins.
- **5-Layer Action Resolution**: button payload → number input → lastMenu index → title match → raw text
- **Hybrid State**: In-memory for speed, DB persistence for durable fields (survives cold starts)
- **Session Timeout**: Configurable auto-reset for abandoned mid-flow conversations
- **Loop Breaker**: Detects stuck users sending the same message repeatedly

## Project Structure

```
src/
├── core/                    # Framework (don't modify per-project)
│   ├── types.ts             # All interfaces
│   ├── engine.ts            # Webhook orchestrator
│   ├── action-resolver.ts   # 5-layer action resolution
│   ├── session.ts           # Timeout + loop breaker
│   └── phone.ts             # Phone normalization
├── adapters/
│   ├── twilio.ts            # Twilio provider (ships ready)
│   ├── memory-store.ts      # In-memory store (default)
│   └── prisma-store.example.ts  # DB store reference
├── debug/
│   ├── viewer.ts            # Live message viewer
│   └── simulator.ts         # WhatsApp-like chat UI
├── handlers/                # YOUR domain handlers
│   ├── order.ts             # Example: stateful flow
│   ├── faq.ts               # Example: stateless + sub-menu
│   └── settings.ts          # Example: back navigation
├── menus/
│   └── main.ts              # Menu definitions
├── bot.ts                   # Configuration (wire everything)
└── index.ts                 # Express + Vercel entry
```

## Building Your Bot

### 1. Define Menus (`src/menus/`)

```typescript
export const MAIN_MENU: MenuButton[] = [
  { id: 'book_appointment', title: '📅 Book Appointment' },
  { id: 'check_status',     title: '🔍 Check Status' },
  { id: 'help',             title: '❓ Help' },
];
```

### 2. Create Handlers (`src/handlers/`)

```typescript
export async function handleBooking(ctx: HandlerContext): Promise<boolean> {
  const { status, action, text, phone, send } = ctx;

  // Entry: user selects from menu
  if (action === 'book_appointment' && status === 'idle') {
    await ctx.setState({ botStatus: 'waiting_date' });
    await send.sendText(phone, 'What date works for you?');
    return true;
  }

  // Collect input
  if (status === 'waiting_date' && text) {
    // Process date, book appointment...
    await ctx.setState({ botStatus: 'idle' });
    await send.sendText(phone, 'Booked!');
    return true;
  }

  return false; // Not our message
}
```

### 3. Wire in `bot.ts`

```typescript
export const botConfig: BotConfig = {
  handlers: [handleBooking, handleStatus, handleHelp],
  statefulStatuses: ['waiting_date', 'waiting_time'],
  // ... rest of config
};
```

### 4. Register stateful statuses

Any `botStatus` value where the bot is waiting for user input must be in `statefulStatuses` for session timeout to work.

## Provider Adapters

### Twilio (included)

Already wired. Set env vars and go.

### Custom Provider

Implement the `ProviderAdapter` interface:

```typescript
const myProvider: ProviderAdapter = {
  sendText(to, body) { /* ... */ },
  sendInteractive(to, bodyText, buttons) { /* ... */ },
  sendMedia(to, body, mediaUrl) { /* ... */ },
  sendTemplate(to, templateId, variables) { /* ... */ },
  validateWebhook(req) { /* ... */ },
  parseWebhook(req) { /* ... */ },
};
```

## Store Adapters

### In-Memory (default)

Zero config. State lost on restart. Fine for development and Vercel (paired with DB persist).

### Prisma (example included)

See `src/adapters/prisma-store.example.ts`. Uncomment and adapt to your schema. The hybrid pattern:
- **Hot path**: in-memory Map (fast reads during conversation)
- **Cold start**: DB seed when Map is empty (Vercel function restart)
- **Writes**: only `botStatus` + `lastMenu` persisted to DB

## Deployment

### Vercel

```bash
node build.mjs           # Bundle to api/index.js
vercel deploy             # Deploy
```

Set your Twilio webhook URL to `https://your-domain.vercel.app/webhook`.

### Standalone Express

```bash
npm run dev       # Development (tsx, hot reload)
npm run build     # Production build
npm start         # Run production bundle
```

## Debug Tools

In non-production (`NODE_ENV !== 'production'`):

- **Simulator** (`/debug/simulator`): WhatsApp-like chat UI. Test flows without Twilio.
- **Viewer** (`/debug/viewer`): Live feed of all inbound/outbound messages with action resolution.
- **Log API** (`/debug/log`): JSON endpoint for the debug ring buffer.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Bundle for Vercel deployment |
| `npm run typecheck` | TypeScript type checking |
| `npm start` | Run production bundle |
