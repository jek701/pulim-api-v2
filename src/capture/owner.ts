import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { database } from '../db/database';
import { documentKey, readDocument } from '../db/documents';
import { isCaptureStorageReady } from './repository';
import { isMerchantTin, isStandardCategoryKey } from './categories';

export interface MerchantReview {
  tin: string; name: string | null; status: string; seen_count: number;
  votes: Array<{ standardKey: string; weight: number; voters: number }>;
}

export async function reviewMerchants(limit = 30): Promise<MerchantReview[]> {
  const merchants = await sql<{ tin: string; name: string | null; status: string; seen_count: number }>`SELECT tin, name, status, seen_count FROM merchants
    WHERE status <> 'verified' ORDER BY last_seen DESC LIMIT ${Math.max(1, Math.min(100, limit))}`.execute(database());
  const result: MerchantReview[] = [];
  for (const merchant of merchants.rows) {
    const votes = await sql<{ standard_key: string; weight_sum: number; voter_count: number }>`SELECT standard_key, weight_sum, voter_count
      FROM merchant_category_votes WHERE tin = ${merchant.tin} AND weight_sum > 0 ORDER BY weight_sum DESC`.execute(database());
    if (merchant.status === 'consensus' && votes.rows.length < 2) continue;
    result.push({ ...merchant, seen_count: Number(merchant.seen_count), votes: votes.rows.map((vote) => ({
      standardKey: vote.standard_key, weight: Number(vote.weight_sum), voters: Number(vote.voter_count),
    })) });
  }
  return result;
}

export async function verifyMerchant(tin: string, standardKey: string): Promise<void> {
  if (!isMerchantTin(tin) || !isStandardCategoryKey(standardKey)) throw new Error('Invalid merchant TIN or standard category key');
  await sql`INSERT INTO merchants (tin, first_seen, last_seen, status, standard_key)
    VALUES (${tin}, ${Date.now()}, ${Date.now()}, 'verified', ${standardKey}) ON DUPLICATE KEY UPDATE
    status = 'verified', standard_key = VALUES(standard_key)`.execute(database());
}

export function summaryWeek(now: Date): string | null {
  // Asia/Tashkent is UTC+05:00 with no DST. A one-hour window survives worker restarts.
  const local = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  return local.getUTCDay() === 1 && local.getUTCHours() === 10 ? local.toISOString().slice(0, 10) : null;
}

export function renderMerchantSummary(merchants: MerchantReview[]): string {
  const lines = merchants.slice(0, 8).map((merchant) => {
    const name = (merchant.name ?? merchant.tin).replace(/[<>]/g, '').slice(0, 50);
    const votes = merchant.votes.slice(0, 2).map((vote) => `${vote.standardKey}: ${vote.weight}`).join(', ');
    return `${name} · ${merchant.tin}${votes ? ` (${votes})` : ''}`;
  });
  return `Справочник продавцов: ${merchants.length} новых или спорных.\n${lines.join('\n')}\nПроверка: npm run merchants -- review`;
}

/** Owner-requested directory digest. No receipt contents, buyer details, or voter identities. */
export async function runMerchantSummary(now = new Date()): Promise<void> {
  const week = summaryWeek(now);
  if (!week || !await isCaptureStorageReady()) return;
  const owners = (process.env.DEV_NOTES_UIDS ?? '').split(',').map((uid) => uid.trim()).filter(Boolean);
  if (!owners.length) return;
  const merchants = await reviewMerchants();
  if (!merchants.length) return;
  for (const uid of owners) {
    const profile = await readDocument(documentKey('profiles', uid));
    const chatId = profile.data.notifications?.telegram?.chatId;
    if (!profile.exists || typeof chatId !== 'string' || !chatId) continue;
    const ownerHash = createHash('sha256').update(uid).digest('hex');
    const claim = await sql`INSERT IGNORE INTO capture_owner_summary (week, owner_hash, claimed_at)
      VALUES (${week}, ${ownerHash}, ${now.getTime()})`.execute(database());
    if (Number(claim.numAffectedRows) !== 1) continue;
    try {
      const { sendMessage } = await import('../telegram/client');
      await sendMessage(chatId, renderMerchantSummary(merchants), { parse_mode: undefined });
    } catch {
      // No provider error payload: it may contain message content or provider credentials.
      await sql`DELETE FROM capture_owner_summary WHERE week = ${week} AND owner_hash = ${ownerHash}`.execute(database());
      throw new Error('Merchant summary delivery failed');
    }
  }
}
