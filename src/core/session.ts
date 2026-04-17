import type { BotConfig } from './types.js';

/**
 * Session timeout check.
 * Returns true if the session has timed out and should be reset.
 *
 * Logic: if the user's last activity was more than `sessionTimeoutMs` ago
 * AND their current botStatus is in the `statefulStatuses` list (meaning
 * they were mid-flow), trigger a timeout reset.
 *
 * Idle users are not timed out — they don't have pending state to lose.
 */
export function checkTimeout(
  state: Record<string, any>,
  config: BotConfig,
): boolean {
  const timeout = config.sessionTimeoutMs ?? 20 * 60 * 1000;
  const lastActive = Number(state._lastUserMessageAt || 0);
  const status = String(state.botStatus || 'idle');

  if (!lastActive) return false;
  if (Date.now() - lastActive <= timeout) return false;

  return config.statefulStatuses.includes(status);
}

/**
 * Loop breaker check.
 * Returns true if the user has sent the same message too many times
 * within the time window while stuck in the same botStatus.
 *
 * Critical production lesson: the counter resets when botStatus changes.
 * Without this, legitimate repeated "1" presses across different wizard
 * steps would trigger false loop breaks.
 */
export function checkLoopBreaker(
  state: Record<string, any>,
  normalizedBody: string,
  config: BotConfig,
): boolean {
  const threshold = config.loopBreakerThreshold ?? 3;
  const window = config.loopBreakerWindowMs ?? 2 * 60 * 1000;

  const lastMsg = String(state._lastUserMessage || '').trim().toLowerCase();
  const lastAt = Number(state._lastUserMessageAt || 0);
  const lastStatus = String(state._lastKnownBotStatus || '');
  const currentStatus = String(state.botStatus || 'idle');

  // Reset counter on status change (prevents false positives across wizard steps)
  if (lastStatus !== currentStatus) {
    state._repeatCount = 0;
    return false;
  }

  const current = normalizedBody.trim().toLowerCase();

  if (
    current &&
    current === lastMsg &&
    Date.now() - lastAt < window
  ) {
    state._repeatCount = (state._repeatCount || 0) + 1;
  } else {
    state._repeatCount = 0;
  }

  return state._repeatCount >= threshold;
}

/** Update tracking fields after timeout/loop checks pass */
export function updateTracking(
  state: Record<string, any>,
  normalizedBody: string,
): void {
  state._lastUserMessage = normalizedBody.trim().toLowerCase();
  state._lastUserMessageAt = Date.now();
  state._lastKnownBotStatus = state.botStatus || 'idle';
}
