import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ premium: vi.fn(), get: vi.fn(), reserve: vi.fn(), refund: vi.fn(), allowance: vi.fn(), warn: vi.fn() }));
vi.mock('../../src/services/entitlement.service', () => ({ getIsPremium: mocks.premium }));
vi.mock('../../src/capture/repository', () => ({ getCaptureUsage: mocks.get, reserveCaptureUsage: mocks.reserve, refundCaptureUsage: mocks.refund, takeCaptureRefund: mocks.allowance }));
vi.mock('../../src/utils/logger', () => ({ logger: { warn: mocks.warn } }));
import { captureQuota, withCaptureQuota, CAPTURE_DAILY_REFUND_CAP } from '../../src/capture/quota';
import { AppError } from '../../src/utils/AppError';
import { captureMonth, dateInTimezone } from '../../src/capture/time';
beforeEach(() => { vi.clearAllMocks(); mocks.premium.mockResolvedValue(false); mocks.get.mockResolvedValue(4); mocks.reserve.mockResolvedValue(true); mocks.refund.mockResolvedValue(undefined); mocks.allowance.mockResolvedValue(true); });
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
  describe('review fixes: refund limits and disconnects', () => {
    const empty = async ({ release }: { release: () => void }) => { release(); return { drafts: [] }; };
    it('refunds an empty result within the daily allowance, then counts the call', async () => {
      expect((await withCaptureQuota('user', true, empty)).quota.used).toBe(4);
      expect(mocks.allowance).toHaveBeenCalledWith('user', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), CAPTURE_DAILY_REFUND_CAP);
      expect(CAPTURE_DAILY_REFUND_CAP).toBe(5);
      expect(mocks.refund).toHaveBeenCalledOnce();
      mocks.allowance.mockResolvedValue(false); mocks.refund.mockClear();
      expect((await withCaptureQuota('user', true, empty)).quota.used).toBe(5);
      expect(mocks.refund).not.toHaveBeenCalled();
    });
    it('treats not_a_receipt like an empty result: refunded only within the allowance', async () => {
      const notReceipt = async () => { throw new AppError(422, 'not_a_receipt'); };
      await expect(withCaptureQuota('user', true, notReceipt)).rejects.toMatchObject({ code: 'not_a_receipt' });
      expect(mocks.refund).toHaveBeenCalledOnce();
      mocks.allowance.mockResolvedValue(false); mocks.refund.mockClear();
      await expect(withCaptureQuota('user', true, notReceipt)).rejects.toMatchObject({ code: 'not_a_receipt' });
      expect(mocks.refund).not.toHaveBeenCalled();
    });
    it('always refunds provider failures, without touching the allowance', async () => {
      mocks.allowance.mockResolvedValue(false);
      await expect(withCaptureQuota('user', true, async () => { throw new Error('provider'); })).rejects.toThrow('provider');
      expect(mocks.refund).toHaveBeenCalledOnce();
      expect(mocks.allowance).not.toHaveBeenCalled();
    });
    it('does not charge, and does not spend the allowance, when the client left before the answer', async () => {
      mocks.allowance.mockResolvedValue(false);
      const controller = new AbortController();
      const result = await withCaptureQuota('user', true, async () => { controller.abort(); return { drafts: [{}] }; }, { signal: controller.signal });
      expect(result.quota.used).toBe(4);
      expect(mocks.refund).toHaveBeenCalledOnce();
      expect(mocks.allowance).not.toHaveBeenCalled();
      mocks.refund.mockClear();
      expect((await withCaptureQuota('user', true, async () => ({ drafts: [{}] }), { signal: new AbortController().signal })).quota.used).toBe(5);
      expect(mocks.refund).not.toHaveBeenCalled();
    });
    it('treats a failing allowance lookup as "no refund" rather than an error', async () => {
      mocks.allowance.mockRejectedValue(new Error('db down'));
      expect((await withCaptureQuota('user', true, empty)).quota.used).toBe(5);
      expect(mocks.warn).toHaveBeenCalledWith('capture.quota_refund_failed');
    });
    it('never refunds an uncounted Soliq call', async () => {
      await withCaptureQuota('user', false, empty);
      expect(mocks.refund).not.toHaveBeenCalled();
      expect(mocks.allowance).not.toHaveBeenCalled();
    });
  });
});
