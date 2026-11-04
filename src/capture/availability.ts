import { env } from '../config/env';
import { isCaptureStorageReady } from './repository';

export async function captureCapabilities(): Promise<{ voice: boolean; receipt: boolean }> {
  const ready = Boolean(env.OPENAI_API_KEY) && await isCaptureStorageReady();
  return { voice: ready, receipt: ready };
}
