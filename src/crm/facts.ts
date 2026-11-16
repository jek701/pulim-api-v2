import { sql } from 'kysely';
import { database } from '../db/database';
import { decodeData } from '../db/values';
import type { UserProfile } from '../domain/types';
import { normalizePushSettings } from '../push/settings';
import { AppError } from '../utils/AppError';
import { normalizeLanguage } from '../telegram/i18n';

/** Positive registration evidence excludes anonymous bootstraps, including legacy profiles. */
export function registeredProfile(profile?: Partial<UserProfile> | null): profile is UserProfile {
  return Boolean(
    profile &&
    !profile.deletionRequestedAt &&
    (profile.isTelegramUser ||
      profile.linkedAuthMethods?.length ||
      profile.primaryAuthMethod ||
      profile.lastAuthMethod),
  );
}
const countTables = {
  accounts: 'cards',
  budgets: 'budgets',
  plans: 'planned_expenses',
  goals: 'savings_goals',
  debts: 'debts',
  subscriptions: 'subscriptions',
  categoriesCustom: 'categories',
} as const;
export type FactCounts = Record<keyof typeof countTables, number>;
export interface FactMetrics {
  counts?: Partial<FactCounts>;
  hasPushDevice?: boolean;
  appVersion?: string;
  lastTransactionAt?: number;
  transactions30d?: number;
  inHousehold?: boolean;
}
const epoch = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
function safeTimezone(value: string): string {
  try {
    if (value.length > 100) return 'Asia/Tashkent';
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return 'Asia/Tashkent';
  }
}
export function userFacts(
  uid: string,
  profile: UserProfile,
  metrics: FactMetrics = {},
  now = Date.now(),
) {
  const settings = normalizePushSettings(profile.notifications, profile.timezone);
  const until = epoch(profile.subscription?.premiumUntil);
  const premium = profile.isPremium === true && until > now;
  return {
    uid,
    createdAt: epoch(profile.createdAt),
    updatedAt: epoch(profile.updatedAt),
    language: normalizeLanguage(profile.language),
    timezone: safeTimezone(settings.timezone),
    tier: premium ? ('premium' as const) : ('free' as const),
    premiumUntil: until,
    isTrial: premium && profile.subscription?.isTrial === true,
    trialUsed:
      profile.subscription?.trialGrantedAt !== undefined ||
      profile.subscription?.isTrial === true ||
      profile.subscription?.source === 'trial',
    hasPushDevice: metrics.hasPushDevice ?? false,
    pushEnabled: settings.enabled,
    marketingPushAllowed: settings.enabled && settings.groups.tips === true,
    // Registration accepts arbitrary metadata. Only version-like strings may cross the boundary.
    appVersion:
      metrics.appVersion && /^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(metrics.appVersion)
        ? metrics.appVersion
        : '',
    telegramLinked:
      profile.isTelegramUser === true ||
      profile.linkedAuthMethods?.includes('telegram') === true ||
      Boolean(profile.telegramChatIds?.length),
    lastTransactionAt: metrics.lastTransactionAt ?? 0,
    transactions30d: metrics.transactions30d ?? 0,
    counts: Object.fromEntries(
      Object.keys(countTables).map((key) => [key, metrics.counts?.[key as keyof FactCounts] ?? 0]),
    ) as FactCounts,
    aiMessages30d: 0,
    captures30d: 0,
    inHousehold: metrics.inHousehold ?? false,
  };
}
function cursorKey(cursor?: string): string | undefined {
  if (cursor === undefined) return undefined;
  const key = Buffer.from(cursor, 'base64url').toString('utf8');
  if (
    !key ||
    Buffer.byteLength(key) > 2048 ||
    key.includes('/') ||
    Buffer.from(key).toString('base64url') !== cursor
  )
    throw AppError.badRequest('Invalid CRM cursor.');
  return key;
}
export const encodeCrmCursor = (key: string) => Buffer.from(key).toString('base64url');
export async function listCrmUsers(input: {
  cursor?: string;
  limit: number;
  updatedSince?: number;
}) {
  const last = cursorKey(input.cursor);
  // Page physical profile keys: anonymous/deleting rows may yield an empty, advancing page.
  let query = database()
    .selectFrom('profiles')
    .select(['id', 'data_json', 'types_json'])
    .orderBy('id')
    .limit(input.limit + 1);
  if (last !== undefined) query = query.where('id', '>', Buffer.from(last));
  const rows = await query.execute();
  const page = rows.slice(0, input.limit);
  return {
    users: await factsForProfiles(page),
    nextCursor:
      rows.length > input.limit ? encodeCrmCursor(String(page[page.length - 1].id)) : null,
  };
}
export async function getCrmFacts(uids: string[]) {
  const rows = await database()
    .selectFrom('profiles')
    .select(['id', 'data_json', 'types_json'])
    .where(
      'id',
      'in',
      [...new Set(uids)].map((uid) => Buffer.from(uid)),
    )
    .execute();
  return { users: await factsForProfiles(rows) };
}
async function factsForProfiles(rows: Record<string, any>[]) {
  const profiles = rows
    .map((row) => ({
      uid: String(row.id),
      data: decodeData(row.data_json, row.types_json) as UserProfile,
    }))
    .filter((row) => registeredProfile(row.data));
  if (!profiles.length) return [];
  const metrics = await loadFactMetrics(profiles.map((row) => row.uid));
  return profiles.map((row) => userFacts(row.uid, row.data, metrics.get(row.uid)));
}
/** Fixed query count per page, all ranges start with an existing owner index. No entity JSON leaves this module. */
export async function loadFactMetrics(
  uids: string[],
  now = Date.now(),
): Promise<Map<string, FactMetrics>> {
  const owners = uids.map((uid) => Buffer.from(uid));
  const result = new Map(uids.map((uid) => [uid, { counts: {} } as FactMetrics]));
  const at = (uid: unknown) => result.get(String(uid))!;
  await Promise.all([
    ...Object.entries(countTables).map(async ([key, table]) => {
      let query = database()
        .selectFrom(table)
        .select(['user_id', sql<number>`COUNT(*)`.as('n')])
        .where('user_id', 'in', owners)
        .groupBy('user_id');
      if (key === 'categoriesCustom')
        query = query.where(sql`SUBSTRING(id, LENGTH(user_id) + 1, 11)`, '<>', '__default__');
      const rows = await query.execute();
      for (const row of rows) at(row.user_id).counts![key as keyof FactCounts] = Number(row.n);
    }),
    (async () => {
      const rows = await database()
        .selectFrom('transactions')
        .select(['user_id', sql<number>`COUNT(*)`.as('n')])
        .where('user_id', 'in', owners)
        .where('date_ms', '>=', now - 30 * 86400000)
        .where('date_ms', '<=', now)
        .groupBy('user_id')
        .execute();
      for (const row of rows) at(row.user_id).transactions30d = Number(row.n);
    })(),
    (async () => {
      // Covering (user_id,date_ms,created_at_ms); MAX(date_ms) supports loose index grouping.
      const rows = await database()
        .selectFrom('transactions')
        .select(['user_id', sql<number>`MAX(date_ms)`.as('latest')])
        .where('user_id', 'in', owners)
        .groupBy('user_id')
        .execute();
      for (const row of rows) at(row.user_id).lastTransactionAt = Number(row.latest ?? 0);
    })(),
    (async () => {
      try {
        const rows = await database()
          .selectFrom('push_devices')
          .select(['uid', 'app_version', 'last_seen_at'])
          .where('uid', 'in', owners)
          .where('disabled_at', 'is', null)
          .orderBy('last_seen_at', 'desc')
          .execute();
        for (const row of rows) {
          const metric = at(row.uid);
          if (!metric.hasPushDevice) {
            metric.hasPushDevice = true;
            metric.appVersion = row.app_version;
          }
        }
      } catch (error) {
        if ((error as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw error;
      }
    })(),
    (async () => {
      // Existing relational membership mirror, indexed by member_user.
      const rows = await database()
        .selectFrom('household_members')
        .select('user_id')
        .where('user_id', 'in', owners)
        .groupBy('user_id')
        .execute();
      for (const row of rows) at(row.user_id).inHousehold = true;
    })(),
  ]);
  return result;
}
