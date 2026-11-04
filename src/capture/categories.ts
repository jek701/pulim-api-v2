import { createHash, createHmac } from 'node:crypto';
import { sql } from 'kysely';
import { database } from '../db/database';
import { DEFAULT_CATEGORIES } from '../domain/defaultCategories';
import type { Category } from '../domain/types';
import { logger } from '../utils/logger';
import { isCaptureStorageReady, safeCachedReceipt } from './repository';

const keyForName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
export const STANDARD_CATEGORY_KEYS = DEFAULT_CATEGORIES.map((category) => keyForName(category.name));
export const isStandardCategoryKey = (key: string): boolean => STANDARD_CATEGORY_KEYS.includes(key);
export const isMerchantTin = (tin: string): boolean => /^(?:\d{9}|\d{14})$/.test(tin);

/** Stable seeded id first; legacy defaults use the Telegram resolver's name/icon/type test. */
export function standardCategoryKey(category: Category): string | null {
  const stable = DEFAULT_CATEGORIES.find((candidate) => category.type === candidate.type
    && category.id.endsWith(`__default__${candidate.type}_${keyForName(candidate.name)}`));
  if (stable) return keyForName(stable.name);
  const legacy = DEFAULT_CATEGORIES.find((candidate) => candidate.name === category.name
    && candidate.icon === category.icon && candidate.type === category.type);
  return legacy ? keyForName(legacy.name) : null;
}

export function categoryForStandardKey(key: string, categories: Category[]): Category | undefined {
  return categories.find((category) => standardCategoryKey(category) === key);
}

export interface CategoryVote { standardKey: string; weight: number; voterCount: number }
export interface CategoryInference { categoryId: string | null; confidence: 'high' | 'medium' | 'low'; standardKey: string | null }
const unresolved = (): CategoryInference => ({ categoryId: null, confidence: 'low', standardKey: null });

export function consensusCategory(votes: CategoryVote[]): string | null {
  const totalWeight = votes.reduce((sum, vote) => sum + vote.weight, 0);
  const winner = [...votes].sort((a, b) => b.weight - a.weight)[0];
  return winner && winner.voterCount >= 3 && totalWeight > 0 && winner.weight / totalWeight >= 0.7
    && isStandardCategoryKey(winner.standardKey) ? winner.standardKey : null;
}

export interface IkpuMapping { prefix: string; standardKey: string | null; source?: string }
export interface IkpuCategory { standardKey: string; viaAi: boolean }

/** Amount-weighted category of the items. `viaAi` when model-classified rows carry half or more of the winner. */
export function ikpuCategory(items: Array<{ ikpu?: string; amount: number }>, mappings: IkpuMapping[]): IkpuCategory | null {
  const totals = new Map<string, { all: number; ai: number }>();
  for (const item of items) {
    if (!item.ikpu || !Number.isFinite(item.amount) || item.amount <= 0) continue;
    const match = mappings.filter((mapping) => item.ikpu!.startsWith(mapping.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (!match?.standardKey || !isStandardCategoryKey(match.standardKey)) continue;
    const entry = totals.get(match.standardKey) ?? { all: 0, ai: 0 };
    entry.all += item.amount;
    if (match.source === 'ai') entry.ai += item.amount;
    totals.set(match.standardKey, entry);
  }
  const ranked = [...totals].sort((a, b) => b[1].all - a[1].all);
  if (!ranked[0] || ranked[0][1].all <= (ranked[1]?.[1].all ?? 0)) return null;
  return { standardKey: ranked[0][0], viaAi: ranked[0][1].ai * 2 >= ranked[0][1].all };
}

export function ikpuWeightedCategory(
  items: Array<{ ikpu?: string; amount: number }>,
  mappings: Array<{ prefix: string; standardKey: string | null }>,
): string | null {
  return ikpuCategory(items, mappings)?.standardKey ?? null;
}

export interface InferenceInput {
  uid: string; tin?: string | null; categories: Category[];
  merchant?: { tin?: string | null; name?: string | null; address?: string | null };
  items?: Array<{ ikpu?: string; amount: number }>;
  /**
   * The TIN came from Soliq (server-fetched), not from text read off a photo. Only then may it touch the
   * shared directory (merchant rows, AI votes, verified/consensus lookups); an untrusted TIN only
   * reaches the user's own remembered choice.
   */
  trustedTin?: boolean;
  /**
   * The receipt was reported by the phone (Soliq data the server could not re-check). Its TIN may only
   * feed the shared directory through the normal consensus: it never overwrites a stored merchant
   * name or address, its AI vote is weaker, and its item codes are never sent for classification.
   */
  deviceReported?: boolean;
  aiGuess?: () => Promise<string | null>;
  /** Only passed for Soliq receipts: item codes read from a photo are never sent for classification. */
  classifyIkpu?: (prefix: string) => Promise<string | null>;
}

/** New IKPU groups the model may classify in one request. */
export const MAX_IKPU_CLASSIFICATIONS = 5;
const STALE_PENDING_MS = 10 * 60_000;

export async function inferCaptureCategory(input: InferenceInput): Promise<CategoryInference> {
  const db = database();
  const mapped = (key: string, confidence: CategoryInference['confidence']): CategoryInference => {
    const category = categoryForStandardKey(key, input.categories);
    return category ? { categoryId: category.id, confidence, standardKey: key } : unresolved();
  };
  const merchantTin = input.tin ?? input.merchant?.tin;
  const tin = merchantTin && isMerchantTin(merchantTin) ? merchantTin : null;
  if (tin && input.trustedTin && input.merchant) {
    const safe = safeCachedReceipt({ merchant: { ...input.merchant, tin } }).merchant as { name: string | null; address: string | null };
    // The directory is best effort: a deadlock or DB error here must never fail the scan.
    try {
      if (input.deviceReported) {
        // Fill-only: an unreviewed phone report must not rename a merchant that already has a name.
        await sql`INSERT INTO merchants (tin, name, address, first_seen, last_seen) VALUES (${tin}, ${safe.name}, ${safe.address}, ${Date.now()}, ${Date.now()})
          ON DUPLICATE KEY UPDATE name = COALESCE(name, VALUES(name)), address = COALESCE(address, VALUES(address))`.execute(db);
      } else {
        await sql`INSERT INTO merchants (tin, name, address, first_seen, last_seen) VALUES (${tin}, ${safe.name}, ${safe.address}, ${Date.now()}, ${Date.now()})
          ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name), address = COALESCE(VALUES(address), address)`.execute(db);
      }
    } catch { logger.warn('capture.directory_write_failed'); }
  }
  if (tin) {
    const personal = await sql<{ category_id: string | Buffer }>`SELECT category_id FROM merchant_user_category
      WHERE uid = ${input.uid} AND tin = ${tin}`.execute(db);
    const personalId = personal.rows[0]?.category_id.toString();
    const category = input.categories.find((candidate) => candidate.id === personalId);
    if (category) return { categoryId: category.id, confidence: 'high', standardKey: standardCategoryKey(category) };
    const merchant = input.trustedTin ? await sql<{ status: string; standard_key: string | null }>`SELECT status, standard_key FROM merchants WHERE tin = ${tin}`.execute(db) : { rows: [] };
    if (merchant.rows[0]?.status === 'verified' && merchant.rows[0].standard_key) {
      return mapped(merchant.rows[0].standard_key, 'high');
    }
    const votes = input.trustedTin ? await sql<{ standard_key: string; weight_sum: number; voter_count: number }>`SELECT standard_key, weight_sum, voter_count
      FROM merchant_category_votes WHERE tin = ${tin}`.execute(db) : { rows: [] };
    const consensus = consensusCategory(votes.rows.map((vote) => ({ standardKey: vote.standard_key, weight: Number(vote.weight_sum), voterCount: Number(vote.voter_count) })));
    if (consensus) return mapped(consensus, 'high');
  }
  const items = input.items ?? [];
  const prefixes = [...new Set(items.flatMap((item) => /^\d{1,17}$/.test(item.ikpu ?? '')
    ? Array.from({ length: item.ikpu!.length }, (_, index) => item.ikpu!.slice(0, index + 1)) : []))];
  if (prefixes.length) {
    const result = await sql<{ prefix: string; standard_key: string | null; source: string }>`SELECT prefix, standard_key, source
      FROM ikpu_category_map WHERE prefix IN (${sql.join(prefixes)})`.execute(db);
    const mappings: IkpuMapping[] = result.rows.map((row) => ({ prefix: row.prefix, standardKey: row.standard_key, source: row.source }));
    if (input.classifyIkpu) {
      let classified = 0;
      for (const item of items) {
        if (classified >= MAX_IKPU_CLASSIFICATIONS) break;
        if (!/^\d{5,17}$/.test(item.ikpu ?? '') || mappings.some((mapping) => item.ikpu!.startsWith(mapping.prefix))) continue;
        const prefix = item.ikpu!.slice(0, 5);
        if (!await claimIkpuPrefix(db, prefix)) continue;
        classified++;
        let key: string | null;
        try { key = await input.classifyIkpu(prefix); }
        catch {
          // No answer is not "uncertain": release the claim so a later scan can try again.
          await sql`DELETE FROM ikpu_category_map WHERE prefix = ${prefix} AND source = 'pending'`.execute(db).catch(() => undefined);
          continue;
        }
        // null is the model's explicit "uncertain"; remember it so the group is not asked again.
        key = key && isStandardCategoryKey(key) ? key : null;
        await sql`UPDATE ikpu_category_map SET standard_key = ${key}, source = 'ai', updated_at = ${Date.now()}
          WHERE prefix = ${prefix}`.execute(db);
        mappings.push({ prefix, standardKey: key, source: 'ai' });
      }
    }
    const found = ikpuCategory(items, mappings);
    // Seeded groups are reliable enough for "medium"; a model-classified group is only a "low" suggestion.
    if (found) return mapped(found.standardKey, found.viaAi ? 'low' : 'medium');
  }
  let aiKey: string | null = null;
  try { aiKey = await input.aiGuess?.() ?? null; } catch { return unresolved(); }
  if (!aiKey || !isStandardCategoryKey(aiKey)) return unresolved();
  if (tin && input.trustedTin) {
    try { await recordAiGuess(tin, aiKey, input.deviceReported ? DEVICE_AI_WEIGHT : AI_WEIGHT); } catch { logger.warn('capture.directory_write_failed'); }
  }
  // A model guess is only ever a highlighted suggestion (confidence low), never a trusted default.
  const suggestion = categoryForStandardKey(aiKey, input.categories);
  return { categoryId: suggestion?.id ?? null, confidence: 'low', standardKey: aiKey };
}

/** Claim once before the model call so concurrent scans cannot all classify a new group.
 * A pending claim abandoned by a crashed process is taken over after ten minutes. */
async function claimIkpuPrefix(db: ReturnType<typeof database>, prefix: string): Promise<boolean> {
  const now = Date.now();
  const inserted = await sql`INSERT IGNORE INTO ikpu_category_map (prefix, standard_key, source, updated_at)
    VALUES (${prefix}, NULL, 'pending', ${now})`.execute(db);
  if (Number(inserted.numAffectedRows) === 1) return true;
  const takeover = await sql`UPDATE ikpu_category_map SET updated_at = ${now}
    WHERE prefix = ${prefix} AND source = 'pending' AND updated_at < ${now - STALE_PENDING_MS}`.execute(db);
  return Number(takeover.numAffectedRows) === 1;
}

/** Weight of a model guess in the shared votes; a phone-reported receipt gets less. */
const AI_WEIGHT = 0.25;
const DEVICE_AI_WEIGHT = 0.1;

async function recordAiGuess(tin: string, key: string, weight: number): Promise<void> {
  await database().transaction().execute(async (db) => {
    // One statement that takes the exclusive row lock straight away. INSERT IGNORE would take a
    // shared lock on an existing row and the following FOR UPDATE would then deadlock two scans.
    await sql`INSERT INTO merchants (tin, first_seen, last_seen) VALUES (${tin}, ${Date.now()}, ${Date.now()})
      ON DUPLICATE KEY UPDATE tin = tin`.execute(db);
    await sql`SELECT tin FROM merchants WHERE tin = ${tin} FOR UPDATE`.execute(db);
    const existing = await sql`SELECT tin FROM merchant_category_votes WHERE tin = ${tin} AND ai_weight > 0 LIMIT 1`.execute(db);
    if (existing.rows.length) return;
    await sql`INSERT INTO merchant_category_votes (tin, standard_key, weight_sum, voter_count, ai_weight)
      VALUES (${tin}, ${key}, ${weight}, 0, ${weight}) ON DUPLICATE KEY UPDATE
      weight_sum = weight_sum + ${weight}, ai_weight = ai_weight + ${weight}`.execute(db);
    await sql`UPDATE merchants SET status = IF(status = 'unknown', 'ai', status),
      standard_key = IF(status IN ('unknown', 'ai'), ${key}, standard_key) WHERE tin = ${tin}`.execute(db);
  });
}

export interface CaptureLearningInput {
  transactionId: string; uid: string; categoryId: string;
  /** Only the suggestion this server issued; the caller has already verified it. */
  suggestedCategoryId?: string;
  merchantTin: string; categories: Category[];
  /** The TIN came from Soliq: it may feed the shared directory. Otherwise only the user's own memory. */
  shared?: boolean;
  /** Saved drafts of one receipt share it: seen_count moves once per receipt. */
  receiptKey?: string;
}
/** Keyed by TIN as well as uid, so one person's votes cannot be linked across merchants. */
export function voterHash(uid: string, tin: string, salt: string): string {
  if (!salt || salt.length < 16) throw new Error('Capture voter salt is not configured');
  return createHmac('sha256', salt).update(`${tin}:${uid}`).digest('hex');
}
export const learningWeight = (chosen: string, suggested?: string): number => suggested && chosen !== suggested ? 2 : 1;

/** Called after the user transaction commits. The caller swallows failures; retry is safe. */
export async function learnCaptureTransaction(input: CaptureLearningInput): Promise<void> {
  if (!isMerchantTin(input.merchantTin) || !await isCaptureStorageReady()) return;
  const category = input.categories.find((candidate) => candidate.id === input.categoryId);
  if (!category) return;
  const now = Date.now();
  if (!input.shared) {
    // Untrusted (photo) TIN: the user's own memory only. No merchant row, no vote, no counters.
    await sql`INSERT INTO merchant_user_category (uid, tin, category_id, updated_at)
      VALUES (${input.uid}, ${input.merchantTin}, ${input.categoryId}, ${now})
      ON DUPLICATE KEY UPDATE category_id = VALUES(category_id), updated_at = VALUES(updated_at)`.execute(database());
    return;
  }
  const key = standardCategoryKey(category);
  const salt = process.env.CAPTURE_VOTER_SALT ?? '';
  // Personal choices still work without a salt; shared voting fails closed.
  const hash = salt.length >= 16 ? voterHash(input.uid, input.merchantTin, salt) : null;
  const weight = learningWeight(input.categoryId, input.suggestedCategoryId);
  const event = createHash('sha256').update(input.receiptKey
    ? `${input.uid}\0receipt\0${input.receiptKey}` : `${input.uid}\0${input.transactionId}`).digest('hex');
  await database().transaction().execute(async (db) => {
    const claimed = await sql`INSERT IGNORE INTO capture_learning (transaction_hash, learned_at) VALUES (${event}, ${now})`.execute(db);
    const first = Number(claimed.numAffectedRows) === 1;
    // A plain transaction learns once. A receipt re-evaluates (its dominant category can change as
    // more split drafts are saved) but counts as one sighting and replaces, never adds, its vote.
    if (!first && !input.receiptKey) return;
    // Exclusive lock in the same statement; all learning for a TIN serializes on this row.
    await sql`INSERT INTO merchants (tin, first_seen, last_seen, seen_count) VALUES (${input.merchantTin}, ${now}, ${now}, ${first ? 1 : 0})
      ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen), seen_count = seen_count + ${first ? 1 : 0}`.execute(db);
    await sql`SELECT tin FROM merchants WHERE tin = ${input.merchantTin} FOR UPDATE`.execute(db);
    await sql`INSERT INTO merchant_user_category (uid, tin, category_id, updated_at)
      VALUES (${input.uid}, ${input.merchantTin}, ${input.categoryId}, ${now})
      ON DUPLICATE KEY UPDATE category_id = VALUES(category_id), updated_at = VALUES(updated_at)`.execute(db);
    const previous = hash ? await sql<{ standard_key: string; weight: number }>`SELECT standard_key, weight
      FROM merchant_latest_votes WHERE tin = ${input.merchantTin} AND voter_hash = ${hash}`.execute(db) : undefined;
    const old = previous?.rows[0];
    if (old) {
      // Unsigned-safe: voter_count is INT UNSIGNED, so no GREATEST(x - 1, 0) (it errors below zero).
      await sql`UPDATE merchant_category_votes SET weight_sum = GREATEST(weight_sum - ${Number(old.weight)}, ai_weight),
        voter_count = IF(voter_count > 0, voter_count - 1, 0) WHERE tin = ${input.merchantTin} AND standard_key = ${old.standard_key}`.execute(db);
    }
    if (hash && !key) {
      await sql`DELETE FROM merchant_latest_votes WHERE tin = ${input.merchantTin} AND voter_hash = ${hash}`.execute(db);
    }
    if (hash && key) {
      await sql`INSERT INTO merchant_latest_votes (tin, voter_hash, standard_key, weight, updated_at)
        VALUES (${input.merchantTin}, ${hash}, ${key}, ${weight}, ${now}) ON DUPLICATE KEY UPDATE
        standard_key = VALUES(standard_key), weight = VALUES(weight), updated_at = VALUES(updated_at)`.execute(db);
      await sql`INSERT INTO merchant_category_votes (tin, standard_key, weight_sum, voter_count, ai_weight)
        VALUES (${input.merchantTin}, ${key}, ${weight}, 1, 0) ON DUPLICATE KEY UPDATE
        weight_sum = weight_sum + ${weight}, voter_count = voter_count + 1`.execute(db);
    }
    const votes = await sql<{ standard_key: string; weight_sum: number; voter_count: number }>`SELECT standard_key, weight_sum, voter_count
      FROM merchant_category_votes WHERE tin = ${input.merchantTin}`.execute(db);
    const consensus = consensusCategory(votes.rows.map((vote) => ({ standardKey: vote.standard_key, weight: Number(vote.weight_sum), voterCount: Number(vote.voter_count) })));
    await sql`UPDATE merchants SET status = IF(status = 'verified', status, ${consensus ? 'consensus' : 'unknown'}),
      standard_key = IF(status = 'verified', standard_key, ${consensus}) WHERE tin = ${input.merchantTin}`.execute(db);
  });
}
