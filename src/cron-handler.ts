import type { Request, Response } from 'express';
import { prisma } from './lib/prisma.js';
import { captureException } from './lib/sentry.js';
import { safeEqual } from './lib/safe-equal.js';

// ── Cron Tick HTTP Handler ───────────────────────────────────
//
// Single HTTP entrypoint that runs your scheduled tasks once per invocation.
// Designed for two trigger sources:
//
//   1. Vercel platform Cron (vercel.json `crons`) — sends a GET with a
//      Bearer token in the Authorization header.
//   2. External per-minute triggers (cron-job.org, EasyCron, GitHub Actions)
//      — must ALSO send `Authorization: Bearer <CRON_SECRET>`. No
//      query-string transport: query strings land in access logs, browser
//      history and Referer headers.
//
// Why HTTP and not an in-process cron: serverless functions are stateless
// per-invocation; a setInterval/cron started during cold start cannot tick
// reliably between requests. The serverless-correct pattern is
// platform Cron → HTTP function → synchronous scan.
//
// Auth model: a single shared secret (CRON_SECRET), constant-time compared,
// fail-closed when unconfigured. Keep every task idempotent (unique
// constraints in the DB) so a double-fired tick is a no-op.

export interface CronTask {
  name: string;
  run: () => Promise<unknown>;
}

interface CronAuth {
  secret: string;
}

// Header-only: `Authorization: Bearer <CRON_SECRET>` (what Vercel cron sends).
function readSecretFromRequest(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim() || null;
  }
  return null;
}

export function createCronHandler(auth: CronAuth, tasks: CronTask[]) {
  return async function handleCronTick(req: Request, res: Response): Promise<void> {
    const startedAt = Date.now();
    const provided = readSecretFromRequest(req);

    if (!auth.secret) {
      // Misconfiguration — fail closed rather than allow unauth invocations.
      console.error('[cron-tick] CRON_SECRET not configured; refusing to run');
      res.status(503).json({ ok: false, error: 'cron_secret_not_configured' });
      return;
    }
    // Constant-time compare — a === would leak the matching prefix length.
    if (provided === null || !safeEqual(provided, auth.secret)) {
      console.warn('[cron-tick] unauthorized — missing or mismatched Bearer secret');
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }

    const results: Array<{ name: string; ok: boolean; error?: string }> = [];
    let anyFailed = false;

    for (const task of tasks) {
      try {
        await task.run();
        console.log(`[cron-tick] task ok — ${task.name}`);
        results.push({ name: task.name, ok: true });
      } catch (err: any) {
        anyFailed = true;
        console.error(`[cron-tick] task error — ${task.name}:`, err);
        captureException(err, { where: `cron-tick:${task.name}` });
        results.push({ name: task.name, ok: false, error: err?.message ?? 'unknown' });
      }
    }

    // TRUE per-tick heartbeat. Append one CronRun row so the latest row proves
    // the tick RAN even when zero work was due. Self-catching: a heartbeat
    // write failure must NEVER change the HTTP response or break the tick.
    try {
      await prisma.cronRun.create({
        data: {
          startedAt: new Date(startedAt),
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
          ok: !anyFailed,
          tasksRun: tasks.length,
          errorMessage: anyFailed
            ? results
                .filter((r) => !r.ok)
                .map((r) => `${r.name}: ${r.error}`)
                .join('; ')
            : null,
        },
      });
    } catch (hbErr) {
      console.error('[cron-tick] heartbeat write failed:', hbErr);
    }

    res.status(anyFailed ? 500 : 200).json({
      ok: !anyFailed,
      elapsedMs: Date.now() - startedAt,
      tasks: results,
    });
  };
}
