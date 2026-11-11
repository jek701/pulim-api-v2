import { createHash } from 'node:crypto';
import { normalizeUsage } from '../ai/agent/usage';
import { documentKey, readDocument, runSqlTransaction, saveDocument } from '../db/documents';
import { callSetupModel, fallbackItem, setupCacheKey } from '../plans/setup';
import type { PlanSetup, SetupItem } from '../plans/schemas';
import { recordAiUsage } from './ai.service';
const DAY = 86400000;
export interface SetupResult {
  items: SetupItem[];
  model: string | null;
  cached: boolean;
  fallback: boolean;
}
export async function getPlanSetup(uid: string, input: PlanSetup): Promise<SetupResult | null> {
  if (!input.groups.length) return { items: [], model: null, cached: false, fallback: false };
  const ref = documentKey('aiForecastCache', setupCacheKey(uid, input));
  const cache = await readDocument(ref);
  if (cache.data?.result && Date.now() - cache.data.generatedAt < DAY)
    return { ...cache.data.result, cached: true };
  // A document counter mirrors capture quota, with a rolling timestamp list (bounded to five).
  // Every uncached attempt takes a slot deliberately: a timed-out call may still be billed.
  const quotaRef = documentKey(
    'aiForecastCache',
    createHash('sha256').update(`plan-setup-quota:${uid}`).digest('hex'),
  );
  const allowed = await runSqlTransaction(async (tx) => {
    const quota = await tx.read(quotaRef);
    const now = Date.now();
    const calls: number[] = (quota.data?.calls ?? []).filter((t: number) => t > now - DAY);
    if (calls.length >= 5) return false;
    tx.save(quotaRef, { userId: uid, calls: [...calls, now] });
    return true;
  });
  if (!allowed) return null;
  const startedAt = Date.now();
  let response: Awaited<ReturnType<typeof callSetupModel>>;
  try {
    response = await callSetupModel(uid, input);
  } catch {
    return { items: input.groups.map(fallbackItem), model: null, cached: false, fallback: true };
  }
  const result: SetupResult = {
    items: response.items,
    model: response.model,
    cached: false,
    fallback: false,
  };
  await saveDocument(ref, { userId: uid, result, generatedAt: Date.now() });
  try {
    await recordAiUsage({
      uid,
      feature: 'plan_setup',
      model: response.model,
      usage: normalizeUsage(response.usage),
      latencyMs: Date.now() - startedAt,
      success: true,
    });
  } catch {
    // Usage reporting must not change a successful result.
  }
  return result;
}
