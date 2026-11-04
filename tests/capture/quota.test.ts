import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ premium: vi.fn(), get: vi.fn(), reserve: vi.fn(), refund: vi.fn(), warn: vi.fn() }));
vi.mock('../../src/services/entitlement.service', () => ({ getIsPremium: mocks.premium }));
vi.mock('../../src/capture/repository', () => ({ getCaptureUsage: mocks.get, reserveCaptureUsage: mocks.reserve, refundCaptureUsage: mocks.refund }));
vi.mock('../../src/utils/logger', () => ({ logger: { warn: mocks.warn } }));
import { captureQuota, withCaptureQuota } from '../../src/capture/quota';
import { captureMonth, dateInTimezone } from '../../src/capture/time';
beforeEach(() => { vi.clearAllMocks(); mocks.premium.mockResolvedValue(false); mocks.get.mockResolvedValue(4); mocks.reserve.mockResolvedValue(true); mocks.refund.mockResolvedValue(undefined); });
describe('capture monthly quota', () => {
  it('rolls months and years exactly at midnight Tashkent, independent of server timezone', () => {
    expect(captureMonth(new Date('2026-11-30T18:59:59.999Z'))).toEqual({ month: '2026-11', resetsAt: '2026-11-30T19:00:00.000Z' });
    expect(captureMonth(new Date('2026-11-30T19:00:00Z'))).toEqual({ month: '2026-12', resetsAt: '2026-12-31T19:00:00.000Z' });
    expect(captureMonth(new Date('2026-12-31T19:00:00Z'))).toEqual({ month: '2027-01', resetsAt: '2027-01-31T19:00:00.000Z' });
    expect(dateInTimezone(new Date('2026-11-01T00:00:00Z'), 'UTC')).toBe('2026-11-01T00:00:00+00:00');
  });
  it.each([[false, 5], [true, 300]])('uses authoritative Premium %s limit %i', async (premium, limit) => {
    mocks.premium.mockResolvedValue(premium);
    expect(await captureQuota('user')).toMatchObject({ used: 4, limit, premium });
  });
  it('allows the final recognition and rejects the next before model work', async () => {
    const work = vi.fn(async () => ({ drafts: [] }));
    expect(await withCaptureQuota('user', true, work)).toMatchObject({ quota: { used: 5, limit: 5 } });
    mocks.get.mockResolvedValue(5); mocks.reserve.mockResolvedValue(false);
    await expect(withCaptureQuota('user', true, work)).rejects.toMatchObject({ statusCode: 402, code: 'capture_quota_exceeded', details: { quota: { used: 5, limit: 5 } } });
    expect(work).toHaveBeenCalledOnce();
  });
  it('does not reserve or reject uncounted Soliq, even at the monthly cap', async () => {
    mocks.get.mockResolvedValue(5); mocks.reserve.mockResolvedValue(false);
    await expect(withCaptureQuota('user', false, async () => ({ receipt: {} }))).resolves.toMatchObject({ quota: { used: 5 } });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it('refunds failed recognition in its reserved month and contains refund failure', async () => {
    mocks.refund.mockRejectedValue(new Error('synthetic failure'));
    await expect(withCaptureQuota('user', true, async () => { throw new Error('model failure'); })).rejects.toThrow('model failure');
    expect(mocks.refund).toHaveBeenCalledWith('user', expect.stringMatching(/^\d{4}-\d{2}$/));
    expect(mocks.warn).toHaveBeenCalledWith('capture.quota_refund_failed');
  });
});
