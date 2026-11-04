import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ env: { OPENAI_API_KEY: '' }, ready: vi.fn() }));
vi.mock('../../src/config/env', () => ({ env: mocks.env }));
vi.mock('../../src/capture/repository', () => ({ isCaptureStorageReady: mocks.ready }));
import { captureCapabilities } from '../../src/capture/availability';
beforeEach(() => { vi.clearAllMocks(); mocks.env.OPENAI_API_KEY = ''; });
describe('capture rollout capability', () => {
  it('stays dark without OpenAI and never probes optional DB tables', async () => {
    expect(await captureCapabilities()).toEqual({ voice: false, receipt: false });
    expect(mocks.ready).not.toHaveBeenCalled();
  });
  it.each([false, true])('requires the applied capture migration (%s)', async ready => {
    mocks.env.OPENAI_API_KEY = 'synthetic'; mocks.ready.mockResolvedValue(ready);
    expect(await captureCapabilities()).toEqual({ voice: ready, receipt: ready });
  });
});
