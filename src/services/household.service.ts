import {
  DocumentKey,
  SqlTransaction,
  countQuery,
  documentKey,
  filterQuery,
  insertDocument,
  limitQuery,
  patchDocument,
  patchValue,
  queryTable,
  readDocument,
  removeDocument,
  runSqlTransaction,
  saveDocument,
  writeBatch,
} from '../db/documents';
import { randomBytes, randomInt } from 'node:crypto';
import { env } from '../config/env';
import { DEFAULT_CATEGORIES, defaultCategoryId } from '../domain/defaultCategories';
import { balanceDelta } from '../domain/balance';
import { FREE_LIMITS } from '../domain/entitlements';
import { getProfile } from '../repositories/profile.repository';
import {
  savePreparedInlineMessage,
  savePreparedKeyboardButton,
  TelegramApiError,
} from '../telegram/client';
import { familyInviteLink, inviteShareArticle, pickButtonText } from '../telegram/familyInvite';
import { normalizeLanguage } from '../telegram/i18n';
import { getIsPremium } from './entitlement.service';
import { verifyTelegramInitData } from './telegramVerify.service';
import { AppError } from '../utils/AppError';
type Row = Record<string, any>;
const households = () => queryTable('households');
const invites = () => queryTable('householdInvites');
const cards = () => queryTable('cards');
const transactions = () => queryTable('transactions');
const categories = () => queryTable('categories');
const budgets = () => queryTable('budgets');
const savingsGoals = () => queryTable('savingsGoals');
const invitePicks = () => queryTable('householdInvitePicks');
const INVITE_PICK_TTL_MS = 60 * 60 * 1000;
/** Bot invitations a household may prepare per day; keeps the bot from being used for spam. */
const INVITE_PICKS_PER_DAY = 20;
async function displayName(uid: string): Promise<string> {
  const profile = await readDocument(documentKey(queryTable('profiles'), uid));
  return String(profile.data?.name || 'Участник');
}
export async function currentHousehold(uid: string): Promise<Row | null> {
  const snap = await readDocument(
    limitQuery(filterQuery(households(), 'memberIds', 'array-contains', uid), 1),
  );
  if (snap.empty) return null;
  const doc = snap.rows[0];
  return { id: doc.id, ...doc.data };
}
export async function requireHousehold(uid: string): Promise<Row> {
  const household = await currentHousehold(uid);
  if (!household) throw AppError.notFound('Совместный бюджет не найден.');
  return household;
}
/** Keep the denormalized member label in sync when a user changes their profile name. */
export async function syncMemberName(uid: string, name: string): Promise<void> {
  const household = await currentHousehold(uid);
  const trimmedName = name.trim();
  if (!household || !trimmedName) return;
  const ref = documentKey(households(), household.id);
  await runSqlTransaction(async (tx) => {
    const snap = await tx.read(ref);
    if (!snap.exists) return;
    const data = snap.data!;
    const members = (data.members ?? []).map((member: Row) =>
      member.userId === uid ? { ...member, name: trimmedName } : member,
    );
    if (!members.some((member: Row) => member.userId === uid)) return;
    tx.patch(ref, { members, updatedAt: Date.now() });
  });
}
export async function createHousehold(
  uid: string,
  input: {
    name: string;
    currency: string;
  },
): Promise<Row> {
  if (await currentHousehold(uid)) {
    throw new AppError(409, 'HOUSEHOLD_EXISTS', 'Вы уже состоите в совместном бюджете.');
  }
  const now = Date.now();
  const name = await displayName(uid);
  const ref = documentKey(households());
  const household = {
    name: input.name.trim(),
    currency: input.currency,
    ownerUserId: uid,
    memberIds: [uid],
    members: [{ userId: uid, name, role: 'owner', joinedAt: now }],
    createdAt: now,
    updatedAt: now,
  };
  const batch = writeBatch();
  batch.insert(ref, household);
  for (const category of DEFAULT_CATEGORIES) {
    const id = defaultCategoryId(`household_${ref.id}`, category.type, category.name);
    batch.save(documentKey(categories(), id), { ...category, householdId: ref.id, createdAt: now });
  }
  await batch.commit();
  return { id: ref.id, ...household };
}
export async function updateHousehold(
  uid: string,
  input: {
    name?: string;
  },
): Promise<Row> {
  const household = await requireHousehold(uid);
  if (household.ownerUserId !== uid) {
    throw AppError.forbidden('HOUSEHOLD_OWNER_REQUIRED', 'Только владелец может менять настройки.');
  }
  const patch = { ...(input.name ? { name: input.name.trim() } : {}), updatedAt: Date.now() };
  await saveDocument(documentKey(households(), household.id), patch, { merge: true });
  return { ...household, ...patch };
}
export async function createInvite(uid: string): Promise<Row> {
  const household = await requireHousehold(uid);
  const token = randomBytes(24).toString('base64url');
  const now = Date.now();
  const invite = {
    householdId: household.id,
    createdBy: uid,
    createdAt: now,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    status: 'pending',
  };
  await insertDocument(documentKey(invites(), token), invite);
  return {
    token,
    householdName: household.name,
    expiresAt: invite.expiresAt,
    link: familyInviteLink(token),
  };
}
async function ownPendingInvite(
  uid: string,
  token: string,
): Promise<{
  household: Row;
  invite: Row;
}> {
  const household = await requireHousehold(uid);
  const snap = await readDocument(documentKey(invites(), token));
  const invite = snap.data;
  if (!snap.exists || !invite || invite.householdId !== household.id) {
    throw AppError.notFound('Приглашение не найдено.');
  }
  if (invite.status !== 'pending' || invite.expiresAt < Date.now()) {
    throw new AppError(410, 'INVITE_EXPIRED', 'Приглашение больше не действует.');
  }
  return { household, invite };
}
/**
 * The Telegram account running the Mini App. Prepared buttons and messages are bound
 * to it, so it comes from verified init data and must belong to this Pulim user.
 */
async function miniAppTelegramId(uid: string, telegramInitData: string): Promise<number> {
  let telegramId = '';
  try {
    const parsed = verifyTelegramInitData(telegramInitData, env.TELEGRAM_BOT_TOKEN);
    telegramId = String(
      (
        JSON.parse(parsed.user ?? '{}') as {
          id?: number | string;
        }
      ).id ?? '',
    );
  } catch {
    telegramId = '';
  }
  if (!telegramId) throw new AppError(401, 'TELEGRAM_AUTH_FAILED', 'Откройте Pulim в Telegram.');
  const mapping = (await readDocument(documentKey(queryTable('telegramUsers'), telegramId))).data;
  if ((mapping?.profileUid ?? mapping?.uid) !== uid) {
    throw AppError.forbidden(
      'TELEGRAM_ACCOUNT_MISMATCH',
      'Этот Telegram не привязан к вашему аккаунту.',
    );
  }
  return Number(telegramId);
}
async function profileLanguage(uid: string) {
  return normalizeLanguage((await getProfile(uid))?.language);
}
async function withTelegram<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof TelegramApiError) {
      throw new AppError(
        502,
        'TELEGRAM_UNAVAILABLE',
        'Telegram сейчас недоступен. Попробуйте ещё раз.',
      );
    }
    throw error;
  }
}
async function takeInvitePickQuota(householdId: string): Promise<void> {
  const ref = documentKey(households(), householdId);
  const day = new Date().toISOString().slice(0, 10);
  await runSqlTransaction(async (tx) => {
    const quota = (await tx.read(ref)).data?.invitePickQuota as
      | {
          day?: string;
          count?: number;
        }
      | undefined;
    const count = quota?.day === day ? (quota.count ?? 0) : 0;
    if (count >= INVITE_PICKS_PER_DAY) {
      throw new AppError(
        429,
        'INVITE_LIMIT',
        'Слишком много приглашений за сегодня. Попробуйте завтра.',
      );
    }
    tx.patch(ref, { invitePickQuota: { day, count: count + 1 } });
  });
}
/**
 * Prepares the Telegram contact picker for an invite. The picked partner reaches the
 * bot as a `users_shared` message, handled by the family invite bot handler.
 */
export async function prepareInvitePick(
  uid: string,
  token: string,
  telegramInitData: string,
): Promise<Row> {
  const { household } = await ownPendingInvite(uid, token);
  if ((household.memberIds ?? []).length >= 2) {
    throw new AppError(409, 'HOUSEHOLD_FULL', 'В этом совместном бюджете уже два участника.');
  }
  const telegramId = await miniAppTelegramId(uid, telegramInitData);
  const language = await profileLanguage(uid);
  await takeInvitePickQuota(household.id);
  const requestId = randomInt(1, 2 ** 31 - 1);
  const prepared = await withTelegram(() =>
    savePreparedKeyboardButton(telegramId, {
      text: pickButtonText(language),
      request_users: {
        request_id: requestId,
        user_is_bot: false,
        max_quantity: 1,
        request_name: true,
        request_username: true,
      },
    }),
  );
  const now = Date.now();
  await insertDocument(documentKey(invitePicks(), `${telegramId}_${requestId}`), {
    token,
    uid,
    householdId: household.id,
    createdAt: now,
    expiresAt: now + INVITE_PICK_TTL_MS,
  });
  await patchDocument(documentKey(invites(), token), {
    delivery: { status: 'awaiting_pick', updatedAt: now },
  });
  return { buttonId: prepared.id };
}
/** Prepares the invite card the Mini App sends to a chat of the user's choice. */
export async function prepareInviteShare(
  uid: string,
  token: string,
  telegramInitData: string,
): Promise<Row> {
  const { household } = await ownPendingInvite(uid, token);
  const telegramId = await miniAppTelegramId(uid, telegramInitData);
  const language = await profileLanguage(uid);
  const prepared = await withTelegram(() =>
    savePreparedInlineMessage(telegramId, inviteShareArticle(language, household.name, token), {
      allow_user_chats: true,
    }),
  );
  return { messageId: prepared.id };
}
export async function inviteStatus(uid: string, token: string): Promise<Row> {
  const household = await requireHousehold(uid);
  const snap = await readDocument(documentKey(invites(), token));
  const invite = snap.data;
  if (!snap.exists || !invite || invite.householdId !== household.id) {
    throw AppError.notFound('Приглашение не найдено.');
  }
  return {
    token,
    status: invite.status,
    expiresAt: invite.expiresAt,
    delivery: invite.delivery ?? null,
  };
}
/** Single-use: resolves a contact pick back to its invite, or null when stale. */
export async function consumeInvitePick(
  telegramId: string,
  requestId: number,
): Promise<{
  token: string;
  inviterUid: string;
  household: Row;
} | null> {
  const ref = documentKey(invitePicks(), `${telegramId}_${requestId}`);
  const pick = await runSqlTransaction(async (tx) => {
    const snap = await tx.read(ref);
    if (!snap.exists) return null;
    tx.remove(ref);
    return snap.data!;
  });
  if (!pick || pick.expiresAt < Date.now()) return null;
  const [inviteSnap, householdSnap] = await Promise.all([
    readDocument(documentKey(invites(), String(pick.token))),
    readDocument(documentKey(households(), String(pick.householdId))),
  ]);
  const invite = inviteSnap.data;
  const household = householdSnap.data;
  if (!invite || invite.status !== 'pending' || invite.expiresAt < Date.now()) return null;
  if (!household || (household.memberIds ?? []).length >= 2) return null;
  return {
    token: String(pick.token),
    inviterUid: String(pick.uid),
    household: { id: householdSnap.id, ...household },
  };
}
export async function recordInviteDelivery(
  token: string,
  delivery: {
    status: 'delivered' | 'not_delivered';
    recipientName: string;
  },
): Promise<void> {
  await patchDocument(documentKey(invites(), token), {
    delivery: { ...delivery, updatedAt: Date.now() },
  });
}
export async function inviteInfo(token: string): Promise<Row> {
  const snap = await readDocument(documentKey(invites(), token));
  if (!snap.exists) throw AppError.notFound('Приглашение не найдено.');
  const invite = snap.data!;
  if (invite.status !== 'pending' || invite.expiresAt < Date.now()) {
    throw new AppError(410, 'INVITE_EXPIRED', 'Приглашение больше не действует.');
  }
  const household = await readDocument(documentKey(households(), invite.householdId));
  if (!household.exists) throw AppError.notFound('Совместный бюджет не найден.');
  return {
    token,
    householdId: household.id,
    householdName: household.data!.name,
    expiresAt: invite.expiresAt,
  };
}
export async function acceptInvite(uid: string, token: string): Promise<Row> {
  const existing = await currentHousehold(uid);
  const info = await inviteInfo(token);
  if (existing && existing.id !== info.householdId) {
    throw new AppError(409, 'HOUSEHOLD_EXISTS', 'Сначала выйдите из текущего совместного бюджета.');
  }
  if (existing && existing.id === info.householdId) return existing;
  const memberName = await displayName(uid);
  const inviteRef = documentKey(invites(), token);
  const householdRef = documentKey(households(), info.householdId);
  await runSqlTransaction(async (tx) => {
    const [inviteSnap, householdSnap] = await Promise.all([
      tx.read(inviteRef),
      tx.read(householdRef),
    ]);
    if (
      !inviteSnap.exists ||
      inviteSnap.data!.status !== 'pending' ||
      inviteSnap.data!.expiresAt < Date.now()
    ) {
      throw new AppError(410, 'INVITE_EXPIRED', 'Приглашение больше не действует.');
    }
    if (!householdSnap.exists) throw AppError.notFound('Совместный бюджет не найден.');
    const data = householdSnap.data!;
    if ((data.memberIds ?? []).length >= 2) {
      throw new AppError(409, 'HOUSEHOLD_FULL', 'В этом совместном бюджете уже два участника.');
    }
    const now = Date.now();
    tx.patch(householdRef, {
      memberIds: patchValue.arrayUnion(uid),
      members: patchValue.arrayUnion({
        userId: uid,
        name: memberName,
        role: 'member',
        joinedAt: now,
      }),
      updatedAt: now,
    });
    tx.patch(inviteRef, { status: 'accepted', acceptedBy: uid, acceptedAt: now });
  });
  return requireHousehold(uid);
}
export async function listHouseholdCategories(uid: string): Promise<Row[]> {
  const household = await requireHousehold(uid);
  const snap = await readDocument(filterQuery(categories(), 'householdId', '==', household.id));
  return snap.rows.map((doc) => ({ id: doc.id, ...doc.data }));
}
export async function listHouseholdBudgets(uid: string): Promise<Row[]> {
  const household = await requireHousehold(uid);
  const snap = await readDocument(filterQuery(budgets(), 'householdId', '==', household.id));
  return snap.rows.map((doc) => ({ id: doc.id, ...doc.data }));
}
export async function setHouseholdBudget(
  uid: string,
  categoryId: string,
  input: {
    amount: number;
    currency: string;
  },
): Promise<Row> {
  const household = await requireHousehold(uid);
  const category = await readDocument(documentKey(categories(), categoryId));
  if (!category.exists || category.data!.householdId !== household.id) {
    throw AppError.notFound('Категория не найдена.');
  }
  const id = `${household.id}_${categoryId}`;
  const row = {
    householdId: household.id,
    categoryId,
    amount: input.amount,
    currency: input.currency,
    updatedAt: Date.now(),
  };
  await saveDocument(documentKey(budgets(), id), row, { merge: true });
  return { id, ...row };
}
export function memberName(household: Row, uid: string): string {
  return household.members?.find((member: Row) => member.userId === uid)?.name ?? 'Участник';
}
function cardDto(card: Row, household: Row, uid: string): Row {
  const isHouseholdAccount = card.scope === 'household';
  const isOwner = card.userId === uid;
  const showBalance = isHouseholdAccount || isOwner || card.familyAccess?.showBalance === true;
  return {
    ...card,
    ownerUserId: isHouseholdAccount ? undefined : card.userId,
    ownerName: isHouseholdAccount ? household.name : memberName(household, card.userId),
    isHouseholdAccount,
    balance: showBalance ? card.balance : 0,
    balanceHidden: !showBalance,
  };
}
export async function listHouseholdCards(uid: string): Promise<Row[]> {
  const household = await requireHousehold(uid);
  const [sharedSnap, personalSnap] = await Promise.all([
    readDocument(filterQuery(cards(), 'householdId', '==', household.id)),
    readDocument(filterQuery(cards(), 'familyAccess.householdId', '==', household.id)),
  ]);
  const rows: Row[] = [
    ...sharedSnap.rows.map((doc) => ({ id: doc.id, ...doc.data }) as Row),
    ...personalSnap.rows
      .map((doc) => ({ id: doc.id, ...doc.data }) as Row)
      .filter((card) => card.familyAccess?.enabled === true),
  ];
  return rows.map((card) => cardDto(card, household, uid));
}
export async function createHouseholdCard(uid: string, input: Row): Promise<Row> {
  const household = await requireHousehold(uid);
  // Shared accounts follow the same free-plan limits as personal ones (see enforceLimit).
  if (!(await getIsPremium(uid))) {
    const count = (
      await readDocument(countQuery(filterQuery(cards(), 'householdId', '==', household.id)))
    ).data.count;
    if (count >= FREE_LIMITS.cards) {
      throw AppError.forbidden('LIMIT_REACHED', `The free plan allows ${FREE_LIMITS.cards} cards.`);
    }
    if (!FREE_LIMITS.allowedCardTypes.includes(input.cardType)) {
      throw AppError.forbidden('PREMIUM_REQUIRED', 'The free plan allows debit cards only.');
    }
  }
  const ref = documentKey(cards());
  const row = {
    ...input,
    scope: 'household',
    householdId: household.id,
    createdBy: uid,
    userId: `household:${household.id}`,
    createdAt: Date.now(),
  };
  await insertDocument(ref, row);
  return cardDto({ id: ref.id, ...row }, household, uid);
}
export async function setCardFamilyAccess(
  uid: string,
  cardId: string,
  input: {
    enabled: boolean;
    showBalance: boolean;
  },
): Promise<Row> {
  const household = await requireHousehold(uid);
  const ref = documentKey(cards(), cardId);
  const snap = await readDocument(ref);
  if (!snap.exists || snap.data!.userId !== uid || snap.data!.scope === 'household') {
    throw AppError.notFound('Личный счёт не найден.');
  }
  const familyAccess = input.enabled
    ? {
        householdId: household.id,
        enabled: true,
        showBalance: input.showBalance,
        updatedAt: Date.now(),
      }
    : patchValue.delete();
  await patchDocument(ref, { familyAccess });
  const updated = await readDocument(ref);
  return { id: updated.id, ...updated.data };
}
export async function listHouseholdGoals(uid: string): Promise<Row[]> {
  const household = await requireHousehold(uid);
  const snap = await readDocument(filterQuery(savingsGoals(), 'householdId', '==', household.id));
  return snap.rows
    .map((doc) => ({ id: doc.id, ...doc.data }) as Row)
    .sort((a, b) => (a.deadline ?? 0) - (b.deadline ?? 0));
}
export async function createHouseholdGoal(uid: string, input: Row): Promise<Row> {
  const household = await requireHousehold(uid);
  const ref = documentKey(savingsGoals());
  const row = {
    ...input,
    savedAmount: 0,
    scope: 'household',
    householdId: household.id,
    userId: `household:${household.id}`,
    createdBy: uid,
    createdAt: Date.now(),
  };
  await insertDocument(ref, row);
  return { id: ref.id, ...row };
}
export async function updateHouseholdGoal(uid: string, id: string, patch: Row): Promise<Row> {
  const household = await requireHousehold(uid);
  const ref = documentKey(savingsGoals(), id);
  const snap = await readDocument(ref);
  if (!snap.exists || snap.data!.householdId !== household.id) {
    throw AppError.notFound('Цель не найдена.');
  }
  const update = { ...patch, updatedAt: Date.now() };
  await saveDocument(ref, update, { merge: true });
  return { id, ...snap.data, ...update };
}
/** Atomically move money from a family-visible account into the canonical shared goal. */
export async function contributeHouseholdGoal(
  uid: string,
  id: string,
  amount: number,
  accountId: string,
): Promise<Row> {
  const household = await requireHousehold(uid);
  return runSqlTransaction(async (tx) => {
    const goalRef = documentKey(savingsGoals(), id);
    const goalSnap = await tx.read(goalRef);
    if (!goalSnap.exists || goalSnap.data!.householdId !== household.id) {
      throw AppError.notFound('Цель не найдена.');
    }
    const goal = goalSnap.data!;
    const card = await allowedCard(tx, household.id, accountId);
    if (!card) throw AppError.notFound('Счёт не найден.');
    if (card.data.currency !== goal.currency) {
      throw AppError.badRequest('Валюта счёта должна совпадать с валютой цели.');
    }
    const now = Date.now();
    const accountOwnerId = card.data.scope === 'household' ? undefined : card.data.userId;
    const transactionRef = documentKey(transactions());
    tx.patch(goalRef, { savedAmount: patchValue.increment(amount), updatedAt: now });
    tx.patch(card.ref, {
      balance: patchValue.increment(balanceDelta(card.data.cardType, 'expense', amount)),
    });
    tx.insert(transactionRef, {
      type: 'expense',
      amount,
      currency: goal.currency,
      categoryId: '',
      cardId: accountId,
      source: 'savings',
      sourceLabel: `Savings: ${goal.name}`,
      goalId: id,
      scope: 'household',
      householdId: household.id,
      createdBy: uid,
      createdByName: memberName(household, uid),
      ...(accountOwnerId
        ? {
            accountOwnerId,
            accountOwnerName: memberName(household, accountOwnerId),
          }
        : {}),
      userId: accountOwnerId ?? `household:${household.id}`,
      date: now,
      createdAt: now,
    });
    return { id, contributed: amount };
  });
}
export async function deleteHouseholdGoal(uid: string, id: string): Promise<void> {
  const household = await requireHousehold(uid);
  const ref = documentKey(savingsGoals(), id);
  const snap = await readDocument(ref);
  if (!snap.exists || snap.data!.householdId !== household.id) {
    throw AppError.notFound('Цель не найдена.');
  }
  await removeDocument(ref);
}
async function allowedCard(
  tx: SqlTransaction,
  householdId: string,
  cardId?: string,
): Promise<{
  ref: DocumentKey;
  data: Row;
} | null> {
  if (!cardId) return null;
  const ref = documentKey(cards(), cardId);
  const snap = await tx.read(ref);
  if (!snap.exists) throw AppError.notFound('Счёт не найден.');
  const data = snap.data!;
  const shared = data.scope === 'household' && data.householdId === householdId;
  const personal =
    data.familyAccess?.enabled === true && data.familyAccess?.householdId === householdId;
  if (!shared && !personal)
    throw AppError.forbidden('CARD_NOT_SHARED', 'Этот счёт недоступен семье.');
  return { ref, data };
}
export async function listHouseholdTransactions(uid: string): Promise<Row[]> {
  const household = await requireHousehold(uid);
  const snap = await readDocument(filterQuery(transactions(), 'householdId', '==', household.id));
  return snap.rows
    .map((doc) => ({ id: doc.id, ...doc.data }) as Row)
    .sort((a, b) => (b.date ?? 0) - (a.date ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
export async function createHouseholdTransaction(uid: string, input: Row): Promise<Row> {
  const household = await requireHousehold(uid);
  const category = await readDocument(documentKey(categories(), String(input.categoryId)));
  if (!category.exists || category.data!.householdId !== household.id) {
    throw AppError.notFound('Категория не найдена.');
  }
  const categoryData = category.data!;
  return runSqlTransaction(async (tx) => {
    const card = await allowedCard(tx, household.id, input.cardId);
    const ref = documentKey(transactions());
    const now = Date.now();
    // With no selected account, the creator paid from their own untracked money.
    // It still belongs in their personal ledger, but it does not move a card balance.
    const accountOwnerId =
      card?.data.scope === 'household' ? undefined : (card?.data.userId ?? uid);
    const row = {
      ...input,
      categoryName: categoryData.name,
      categoryIcon: categoryData.icon,
      categoryColor: categoryData.color,
      scope: 'household',
      householdId: household.id,
      createdBy: uid,
      createdByName: memberName(household, uid),
      ...(accountOwnerId
        ? {
            accountOwnerId,
            accountOwnerName: memberName(household, accountOwnerId),
          }
        : {}),
      userId: accountOwnerId ?? `household:${household.id}`,
      createdAt: now,
    };
    tx.insert(ref, row);
    if (card) {
      tx.patch(card.ref, {
        balance: patchValue.increment(balanceDelta(card.data.cardType, input.type, input.amount)),
      });
    }
    return { id: ref.id, ...row };
  });
}
/** Edit an ordinary family operation and move its balance impact atomically. */
export async function updateHouseholdTransaction(
  uid: string,
  id: string,
  patch: Row,
): Promise<Row> {
  const household = await requireHousehold(uid);
  const categoryId = typeof patch.categoryId === 'string' ? patch.categoryId : null;
  const category = categoryId ? await readDocument(documentKey(categories(), categoryId)) : null;
  if (category && (!category.exists || category.data!.householdId !== household.id)) {
    throw AppError.notFound('Категория не найдена.');
  }
  return runSqlTransaction(async (tx) => {
    const ref = documentKey(transactions(), id);
    const snap = await tx.read(ref);
    if (!snap.exists || snap.data!.householdId !== household.id) {
      throw AppError.notFound('Операция не найдена.');
    }
    const old = snap.data!;
    if (old.source) {
      throw AppError.badRequest('Эту операцию нужно менять в соответствующем разделе.', {
        source: old.source,
      });
    }
    const merged = { ...old, ...patch };
    const oldCardId = old.cardId ? String(old.cardId) : undefined;
    const newCardId = merged.cardId ? String(merged.cardId) : undefined;
    // Firestore requires all reads before writes. The old card may no longer be
    // shared, but its original balance impact still has to be reversed.
    const oldCardRef = oldCardId ? documentKey(cards(), oldCardId) : null;
    const oldCardSnap = oldCardRef ? await tx.read(oldCardRef) : null;
    const oldCardData = oldCardSnap?.exists ? oldCardSnap.data! : null;
    const oldCardIsOriginal =
      oldCardData &&
      ((oldCardData.scope === 'household' && oldCardData.householdId === household.id) ||
        (old.accountOwnerId && oldCardData.userId === old.accountOwnerId));
    const newCard =
      newCardId === oldCardId && oldCardIsOriginal
        ? (() => {
            const shared =
              oldCardData.scope === 'household' && oldCardData.householdId === household.id;
            const personal =
              oldCardData.familyAccess?.enabled === true &&
              oldCardData.familyAccess?.householdId === household.id;
            if (!shared && !personal) {
              throw AppError.forbidden('CARD_NOT_SHARED', 'Этот счёт недоступен семье.');
            }
            return { ref: oldCardRef!, data: oldCardData };
          })()
        : await allowedCard(tx, household.id, newCardId);
    if (oldCardRef && oldCardData && oldCardIsOriginal && newCard && oldCardId === newCardId) {
      const delta =
        -balanceDelta(oldCardData.cardType, old.type, old.amount) +
        balanceDelta(newCard.data.cardType, merged.type, merged.amount);
      if (delta !== 0) tx.patch(oldCardRef, { balance: patchValue.increment(delta) });
    } else {
      if (oldCardRef && oldCardData && oldCardIsOriginal) {
        tx.patch(oldCardRef, {
          balance: patchValue.increment(-balanceDelta(oldCardData.cardType, old.type, old.amount)),
        });
      }
      if (newCard) {
        tx.patch(newCard.ref, {
          balance: patchValue.increment(
            balanceDelta(newCard.data.cardType, merged.type, merged.amount),
          ),
        });
      }
    }
    const fallbackOwnerId = String(old.createdBy || uid);
    const accountOwnerId =
      newCard?.data.scope === 'household' ? undefined : (newCard?.data.userId ?? fallbackOwnerId);
    const writePatch: Row = {
      ...patch,
      ...(category
        ? {
            categoryName: category.data!.name,
            categoryIcon: category.data!.icon,
            categoryColor: category.data!.color,
          }
        : {}),
      accountOwnerId: accountOwnerId ?? patchValue.delete(),
      accountOwnerName: accountOwnerId
        ? memberName(household, accountOwnerId)
        : patchValue.delete(),
      userId: accountOwnerId ?? `household:${household.id}`,
      updatedAt: Date.now(),
    };
    tx.save(ref, writePatch, { merge: true });
    return {
      id,
      ...merged,
      ...writePatch,
      accountOwnerId,
      accountOwnerName: accountOwnerId ? memberName(household, accountOwnerId) : undefined,
    };
  });
}
export async function deleteHouseholdTransaction(uid: string, id: string): Promise<void> {
  const household = await requireHousehold(uid);
  await runSqlTransaction(async (tx) => {
    const ref = documentKey(transactions(), id);
    const snap = await tx.read(ref);
    if (!snap.exists || snap.data!.householdId !== household.id) {
      throw AppError.notFound('Операция не найдена.');
    }
    const row = snap.data!;
    if (row.source) {
      throw AppError.badRequest('Эту операцию нужно удалять в соответствующем разделе.', {
        source: row.source,
      });
    }
    const cardRef = row.cardId ? documentKey(cards(), String(row.cardId)) : null;
    const cardSnap = cardRef ? await tx.read(cardRef) : null;
    const cardData = cardSnap?.exists ? cardSnap.data! : null;
    const isOriginalSource =
      cardData &&
      ((cardData.scope === 'household' && cardData.householdId === household.id) ||
        (row.accountOwnerId && cardData.userId === row.accountOwnerId));
    if (cardRef && cardData && isOriginalSource) {
      tx.patch(cardRef, {
        balance: patchValue.increment(-balanceDelta(cardData.cardType, row.type, row.amount)),
      });
    }
    tx.remove(ref);
  });
}
