/** Opt-in synthetic evaluation; never imported by production. */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { callSetupModel } from '../plans/setup';
import { estimateCostUsd, normalizeUsage } from '../ai/agent/usage';
import type { PlanSetup, SetupItem } from '../plans/schemas';
interface EvalCase {
  id: string;
  input: PlanSetup;
  expected: { ids: string[]; role: SetupItem['role'] }[];
}
async function main() {
  if (!process.env.OPENAI_API_KEY)
    throw new Error('Set OPENAI_API_KEY in the environment before running eval:plan-setup');
  const load = createRequire(__filename);
  const { planSetupCases } = load(resolve('tests/fixtures/planSetupCases.ts')) as {
    planSetupCases: EvalCase[];
  };
  const answers = [];
  let roles = 0,
    total = 0,
    mergeCorrect = 0,
    mergeTotal = 0;
  for (const c of planSetupCases) {
    try {
      const result = await callSetupModel('synthetic-plan-setup-user', c.input);
      for (const g of c.input.groups) {
        total++;
        if (
          result.items.find((i) => i.groupIds.includes(g.id))?.role ===
          c.expected.find((i) => i.ids.includes(g.id))?.role
        )
          roles++;
      }
      // Exact partition correctness per case, independent of item order and labels.
      const partition = (ids: string[][]) =>
        ids
          .map((xs) => [...xs].sort().join('|'))
          .sort()
          .join(';');
      mergeTotal++;
      const merges =
        partition(result.items.map((i) => i.groupIds)) === partition(c.expected.map((i) => i.ids));
      if (merges) mergeCorrect++;
      const usage = normalizeUsage(result.usage);
      answers.push({
        id: c.id,
        items: result.items,
        merges,
        costUsd: usage ? estimateCostUsd(result.model, usage) : null,
      });
    } catch {
      total += c.input.groups.length;
      mergeTotal++;
      answers.push({ id: c.id, error: 'Model call failed', costUsd: null });
    }
  }
  const summary = {
    cases: answers.length,
    roleAccuracy: roles / total,
    mergeAccuracy: mergeCorrect / mergeTotal,
    meanCostUsd: answers.some((a) => a.costUsd === null)
      ? null
      : answers.reduce((n, a) => n + a.costUsd!, 0) / answers.length,
  };
  console.log(JSON.stringify(summary));
  await writeFile(
    resolve('plan-setup-eval-report.json'),
    JSON.stringify({ ...summary, answers }, null, 2) + '\n',
  );
}
if (require.main === module)
  void main().catch(() => {
    console.error('Plan setup evaluation failed');
    process.exitCode = 1;
  });
