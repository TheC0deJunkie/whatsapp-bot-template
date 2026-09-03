import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the SDK so no real Sentry calls happen. The wrapper is the only
// importer of @sentry/node — we assert on these mocks to prove forwarding.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  setupExpressErrorHandler: vi.fn(),
}));

// The wrapper caches `enabled`/`initialized` at module scope, so each test
// re-imports a fresh module instance after vi.resetModules() to avoid state
// leaking between the disabled/enabled cases.
async function freshWrapper() {
  vi.resetModules();
  // Re-applying the mock survives resetModules in vitest hoisting, but we
  // re-grab the mocked module each time to reset call history deterministically.
  return await import('./sentry.js');
}

async function mockedSentry() {
  return await import('@sentry/node');
}

describe('sentry wrapper', () => {
  let originalDsn: string | undefined;

  beforeEach(() => {
    originalDsn = process.env.SENTRY_DSN;
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore the original env so the rest of the suite runs with the same
    // SENTRY_DSN state it had before (unset by default → Sentry disabled).
    if (originalDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalDsn;
    }
  });

  it('Test A — disabled: no Sentry calls and no throw when SENTRY_DSN unset', async () => {
    delete process.env.SENTRY_DSN;
    const { initSentry, captureException } = await freshWrapper();
    const Sentry = await mockedSentry();

    initSentry();
    expect(Sentry.init).not.toHaveBeenCalled();

    // Must be a pure no-op and must not throw.
    expect(() => captureException(new Error('x'))).not.toThrow();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('Test B — enabled: init forwards with tracesSampleRate 0 and capture forwards with extra', async () => {
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/123';
    const { initSentry, captureException } = await freshWrapper();
    const Sentry = await mockedSentry();

    initSentry();
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://public@example.ingest.sentry.io/123',
        tracesSampleRate: 0,
        // PRIVACY guard — user data must never ship to Sentry.
        sendDefaultPii: false,
      }),
    );
    // environment is always passed (NODE_ENV ?? 'development').
    const initArg = (Sentry.init as any).mock.calls[0][0];
    expect(initArg.environment).toBeTypeOf('string');

    const err = new Error('boom');
    captureException(err, { where: 'x' });
    expect(Sentry.captureException).toHaveBeenCalledWith(err, { extra: { where: 'x' } });
  });

  it('Test C — swallow-throw: captureException never propagates a thrown Sentry error', async () => {
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/123';
    const { initSentry, captureException } = await freshWrapper();
    const Sentry = await mockedSentry();

    initSentry();
    (Sentry.captureException as any).mockImplementation(() => {
      throw new Error('sentry exploded');
    });

    expect(() => captureException(new Error('boom'), { where: 'y' })).not.toThrow();
  });

  it('Test D — express handler: no-op when disabled, forwards the app when enabled', async () => {
    // Disabled — must not touch the SDK and must not throw.
    delete process.env.SENTRY_DSN;
    {
      const { initSentry, setupSentryErrorHandler } = await freshWrapper();
      const Sentry = await mockedSentry();
      initSentry();
      const fakeApp = {};
      expect(() => setupSentryErrorHandler(fakeApp)).not.toThrow();
      expect(Sentry.setupExpressErrorHandler).not.toHaveBeenCalled();
    }

    // Enabled — forwards the express app to the SDK.
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/123';
    {
      const { initSentry, setupSentryErrorHandler } = await freshWrapper();
      const Sentry = await mockedSentry();
      initSentry();
      const fakeApp = {};
      setupSentryErrorHandler(fakeApp);
      expect(Sentry.setupExpressErrorHandler).toHaveBeenCalledWith(fakeApp);
    }
  });
});
