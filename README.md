# WhatsApp Bot Template

A production-hardened starting point for building WhatsApp bots in TypeScript. Provider-agnostic core (Twilio + Meta Cloud API adapters included), Prisma/Postgres session store, numbered-menu UX that works without interactive-message approval, a 16-step webhook pipeline with the failure modes already handled, and a serverless-correct cron skeleton.

Everything here was extracted from a bot running in production. The comments preserve the incidents that shaped the code — read them before deleting them.

## Stack

- Node 20+, TypeScript (strict, ESM), Express
- Prisma + Postgres (Neon works well; any Postgres does)
- Twilio WhatsApp **or** Meta WhatsApp Cloud API (pick via `WHATSAPP_PROVIDER`)
- Vitest for tests, esbuild for the Vercel bundle
- Optional: Sentry (no-op unless `SENTRY_DSN` is set)

## Quickstart

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL + provider creds
npx prisma migrate dev        # creates the initial migration from schema.prisma
npm run seed                  # one test user at first-contact state
ENABLE_DEBUG_ROUTES=true TWILIO_SKIP_WEBHOOK_VALIDATION=true npm run dev
# open http://localhost:3000/debug/simulator and say "hi"
```

`npm test` and `npm run typecheck` should both be green before and after your changes.

## What the template ships

Three example flows wired end-to-end, meant to be replaced:

- **Onboarding** — first contact → capture full name → main menu (`src/handlers/onboarding.ts`)
- **Profile** — view card + edit name; a two-level flow with `back` wired between levels (`src/handlers/profile.ts`)
- **Echo demo** — the smallest sticky capture flow: holds a status, consumes free text, exits via back/menu/skip (`src/handlers/echo.ts`)

Plus the machinery every WhatsApp bot ends up needing:

| Piece | Where | Why it matters |
|---|---|---|
| 16-step webhook pipeline | `src/core/engine.ts` | Signature validation, inbound dedup, retry-on-transient-DB-error, loop breaker, session timeout, graceful handler-crash replies. Every guard is a production postmortem. |
| 5-layer action resolver | `src/core/action-resolver.ts` | Numbered text menus (`*[1]* Title`) instead of interactive messages — no template approval needed, and `"1"` replies resolve deterministically via `state.lastMenu`. |
| Session store | `src/adapters/prisma-store.ts` | Hot in-memory map + durable `BotSession` row. The DB is always the source of truth — the comment explains the concurrent-lambda bug that forced this. |
| back/skip navigation | `src/core/navigation.ts` | Table-driven `BACK_MAP`/`SKIP_MAP` + re-render dispatch in `bot.ts`. Back never silently fails. |
| Template approval gate | `src/services/whatsapp-templates.ts` | Outside the 24h window only approved templates deliver. Registry → sync → live-verified status check → free-form fallback. |
| Error-code map | `src/services/whatsapp-error-codes.ts` | The Twilio/Meta failure codes you will meet, with what they actually mean. |
| Cron skeleton | `src/cron-handler.ts` | HTTP-driven (`/api/cron-tick`, Bearer `CRON_SECRET`, constant-time compare, fail-closed), with a `CronRun` heartbeat row per tick. |
| Delivery tracking | `src/services/delivery-log.ts` | `MessageDelivery` rows seeded at send, updated by status callbacks. |
| Local simulator | `src/debug/simulator.ts` | Drive the real engine from a browser with no Twilio account. |

## Directory guide

```
src/
  core/        engine, action resolver, navigation maps, phone utils, types — rarely touched
  adapters/    twilio.ts, meta.ts (ProviderAdapter), prisma-store.ts (StoreAdapter)
  handlers/    one file per flow — this is where your bot lives
  copy/        every user-facing string, one module per flow
  services/    domain-free helpers (templates, logging, dates, timezones)
  debug/       viewer + simulator (dev-only, double-gated)
  bot.ts       THE composition root — flows, commands, lifecycle wiring
  index.ts     Express entry — webhook, health, keep-alive, cron-tick
prisma/        schema (framework models; add yours below them)
scripts/       seed, switch-webhook (flips Twilio webhook between local tunnel and prod)
```

## How to add a flow

A flow = statuses + a handler + copy + navigation entries. Five touches:

1. **Copy** — `src/copy/my-flow.ts`, re-export from `src/copy/index.ts`.
2. **Handler** — `src/handlers/my-flow.ts`: a `start<Flow>(ctx)` that sets `botStatus` and sends the prompt, plus a `handle<Flow>` that early-returns `false` unless it owns `ctx.status`. Return `false` on empty text so `onFallback` re-prompts.
3. **Wire** — add the handler to `botConfig.handlers` (order matters; before `handleMainMenu`), the statuses to `statefulStatuses`, and a menu row / action id if it starts from the menu.
4. **Navigation** — `BACK_MAP` (+ `SKIP_MAP` if optional) in `src/core/navigation.ts`, and a re-render case in `bot.ts` `rerenderForStatus`.
5. **Escape** — if the entry action is a top-level menu row, add its id to `TOP_LEVEL_NAV_ACTIONS` so a button tap always escapes a sticky flow (the engine.test parity test will remind you).

Multi-step flows that must survive serverless cold starts persist their drafts: add a `BotSession` column, a `DurableFields` entry (`src/core/types.ts`), and a mapping in `prisma-store.ts` `get()`/`persist()` — three places, that's the whole pattern.

## UX rules baked in

- **Three-tap rule** — every flow completes within ≤3 user messages.
- **Never silent** — every inbound gets a reply: fallbacks re-prompt, handler crashes apologize, state-load failures say so explicitly instead of faking an empty session.
- **Always an exit** — `back`, `menu`, `skip`, `reset`, `help` work everywhere; prompts carry the footer that says so.
- **Copy lives in `src/copy/`** — never inline strings in handlers.

## The 24-hour window (read this before shipping)

WhatsApp only lets you send free-form messages within 24h of the user's last inbound message. Outside that window you must use a pre-approved template, and the failure is *silent* (the API accepts the send, delivery fails asynchronously). The pattern in `whatsapp-templates.ts`:

1. Define templates in the registry, versioned names (`hello_v1` → `hello_v2` on any body change).
2. Run `syncTemplates(auth)` (script or deploy hook) to provision + submit for approval.
3. At send time, `getContentTemplate(name, auth)` → branch on `status === 'approved'` → `sendContentTemplate` or free-form fallback.
4. Gate on **live-verified** status. An approved template can still fail at send time (error 63028); watch `MessageDelivery` rows, not API acceptance.

## Deploy (Vercel)

- `vercel.json` bundles via `node build.mjs` → `api/index.js`; `/webhook`, `/health`, `/keep-alive`, `/api/*` rewrites included.
- Set env vars in the Vercel project (see `.env.example`; `WEBHOOK_BASE_URL`, `TWILIO_AUTH_TOKEN` and `CRON_SECRET` are hard-required in production — startup fails loudly without them).
- Point the Twilio sender's webhook at `https://<your-app>/webhook` (or use `npm run webhook:prod` after setting `PROD_BASE_URL`).
- Cron: `vercel.json` triggers `/api/cron-tick` daily; add an external per-minute pinger (cron-job.org etc.) with the same Bearer header if you need finer grain. If your Postgres auto-suspends (Neon free tier), ping `/keep-alive` every ~4 minutes.

## What was deliberately left out

- Admin UI / REST API routes, auth (OTP/JWT), LLM parsing, referral graphs, reminder scheduling — those are product decisions, not framework. The seams they plug into (`ctx.providerAuth`, `CronTask[]`, the handler chain) are all here.
- A flow DSL. Flows are code on purpose; a JSON workflow engine is how templates die.
- No initial Prisma migration — run `prisma migrate dev` once so the migration history is yours.
