import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_CATEGORIES, defaultCategoryId } from '../domain/defaultCategories';

/**
 * Explicit opt-in (`npm run capture:eval`), never part of `npm test`. Loads the normal server env
 * and exits without any network call unless OPENAI_API_KEY is set. Scores the parse stage on the
 * synthetic phrases; the transcription stage needs real audio and is not covered.
 */
async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    process.stdout.write('Capture model evaluation skipped: OPENAI_API_KEY is not supplied.\n');
    return;
  }
  const { parseCaptureVoice } = await import('../capture/models');
  const phrases = JSON.parse(await readFile(resolve('tests/capture/eval/phrases.json'), 'utf8')) as Array<{
    language: string; text: string; operationCount: number;
    operations: Array<{ amount: number; currency: string; type: string; categoryKey: string; lowConfidence?: boolean }>;
  }>;
  const uid = 'capture_synthetic_eval';
  const categories = DEFAULT_CATEGORIES.map(c => ({ ...c, id: defaultCategoryId(uid, c.type, c.name), userId: uid, createdAt: 0 }));
  type Score = { cases: number; count: number; fields: number; amount: number; type: number; category: number; currency: number; flagged: number; flagExpected: number };
  const totals: Record<string, Score> = {};
  for (const phrase of phrases) {
    const score = totals[phrase.language] ??= { cases: 0, count: 0, fields: 0, amount: 0, type: 0, category: 0, currency: 0, flagged: 0, flagExpected: 0 };
    score.cases++;
    try {
      const drafts = await parseCaptureVoice(uid, phrase.text, { categories, accounts: [], recent: [], merchantNames: [],
        timezone: 'Asia/Tashkent', now: new Date('2026-11-04T12:00:00+05:00') }, { recordUsage: false });
      if (drafts.length === phrase.operationCount) score.count++;
      for (let index = 0; index < phrase.operations.length; index++) {
        const expected = phrase.operations[index];
        const draft = drafts[index];
        score.fields++;
        if (!draft) continue;
        if (Math.abs(draft.amount - expected.amount) < 0.005) score.amount++;
        if (draft.type === expected.type) score.type++;
        if (expected.lowConfidence) { score.flagExpected++; if (draft.lowConfidenceFields.includes('amount')) score.flagged++; }
        if (draft.currency === expected.currency) score.currency++;
        const category = categories.find(c => c.id === draft.categoryId);
        if (category?.name.toLowerCase().replace(/\s+/g, '_') === expected.categoryKey) score.category++;
      }
    } catch {
      score.fields += phrase.operations.length;
      // Only aggregate metrics, never model errors or transcripts.
    }
  }
  const pct = (n: number, d: number) => `${(100 * n / Math.max(d, 1)).toFixed(1)}%`;
  for (const [language, score] of Object.entries(totals)) {
    process.stdout.write(`${language}: operations=${pct(score.count, score.cases)} amount=${pct(score.amount, score.fields)} currency=${pct(score.currency, score.fields)} type=${pct(score.type, score.fields)} category=${pct(score.category, score.fields)} lowConfidenceRecall=${score.flagExpected ? pct(score.flagged, score.flagExpected) : 'n/a'}\n`);
  }
}
void main().catch(() => { process.stderr.write('Capture evaluation failed.\n'); process.exitCode = 1; });
