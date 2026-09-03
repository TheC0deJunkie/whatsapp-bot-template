import type { Request, Response } from 'express';
import { prisma } from './lib/prisma.js';

// ── Keep-Alive Handler ───────────────────────────────────────
//
// Tiny health-ping endpoint that runs `SELECT 1` against Postgres to keep
// the Neon compute warm. Returns 200 {ok:true,db:'up'} on success or 500
// {ok:false,db:'down',error} on failure. See
// `.planning/debug/resolved/silent-bot-post-d5b1809-260519.md` for the
// incident that motivated this — Neon idle-suspended for ~6h on 2026-05-19
// and every Twilio webhook returned 500 "Lookup failed". This is the second
// occurrence of the same Layer-3 failure (first: 2026-04-20), so the
// keep-alive mitigation is now mandatory rather than optional.
//
// Wired into Vercel Cron at `*/4 * * * *` (see vercel.json crons[]). The
// 4-minute cadence sits below Neon's typical 5-minute idle-suspend window
// so the compute stays permanently warm on normal-traffic days.
//
// Auth: open by design. Mirrors /health (also open). The query is `SELECT 1`
// — zero data exposure, no side effects, smallest possible Postgres
// roundtrip. Same surface area exists today via /health and /webhook.

export function createKeepAliveHandler(): (
  req: Request,
  res: Response,
) => Promise<void> {
  return async (_req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ ok: true, db: 'up' });
    } catch (err) {
      // Prisma's connection-pool layer occasionally throws strings rather
      // than Error instances (e.g. raw timeout sentinels), so coerce
      // defensively before serializing.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[keep-alive] db unreachable: ${message}`);
      res.status(500).json({ ok: false, db: 'down', error: message });
    }
  };
}
