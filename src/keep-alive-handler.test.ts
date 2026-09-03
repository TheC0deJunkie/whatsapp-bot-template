import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ── Mocks (hoisted) ───────────────────────────────────────────
// Mock the prisma singleton so the handler under test never touches a real
// Postgres connection. The mock factory wires `prisma.$queryRaw` through to a
// reusable spy that each test can configure with mockResolvedValueOnce /
// mockRejectedValueOnce.
const mockQueryRaw = vi.fn();
vi.mock('./lib/prisma.js', () => ({
  prisma: { $queryRaw: (...args: any[]) => mockQueryRaw(...args) },
}));

const { createKeepAliveHandler } = await import('./keep-alive-handler.js');

// ── Helpers ───────────────────────────────────────────────────
function makeRes(): Response & { _status?: number; _body?: any } {
  const res: any = {
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
  };
  return res;
}
const makeReq = (): Request => ({}) as Request;

// ── Tests ─────────────────────────────────────────────────────
describe('createKeepAliveHandler', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockQueryRaw.mockReset();
    // Re-spy fresh each test. `vi.spyOn` returns the same underlying spy
    // when called twice on the same property, so an explicit mockReset() is
    // required to zero the call count between tests — otherwise call-count
    // assertions (toHaveBeenCalledTimes(1)) leak across tests.
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    errSpy.mockReset();
    errSpy.mockImplementation(() => {});
  });

  it('returns 200 {ok:true,db:"up"} when SELECT 1 resolves', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
    const handler = createKeepAliveHandler();
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true, db: 'up' });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('returns 500 {ok:false,db:"down",error} when $queryRaw rejects with an Error', async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error("Can't reach database server"));
    const handler = createKeepAliveHandler();
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(500);
    expect(res._body).toEqual({
      ok: false,
      db: 'down',
      error: "Can't reach database server",
    });
  });

  it('logs the failure with the [keep-alive] prefix', async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error('pool timeout'));
    await createKeepAliveHandler()(makeReq(), makeRes());
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[keep-alive]'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('pool timeout'));
  });

  it('coerces non-Error rejections to a string in the error field', async () => {
    mockQueryRaw.mockRejectedValueOnce('timeout');
    const res = makeRes();
    await createKeepAliveHandler()(makeReq(), res);
    expect(res._status).toBe(500);
    expect(res._body).toEqual({ ok: false, db: 'down', error: 'timeout' });
  });
});
