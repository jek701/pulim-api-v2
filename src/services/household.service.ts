import { randomBytes, randomInt } from 'node:crypto';
import { env } from '../config/env';
import { db, FieldValue } from '../config/firebase';
import { DEFAULT_CATEGORIES, defaultCategoryId } from '../domain/defaultCategories';
import { balanceDelta } from '../domain/balance';
import { FREE_LIMITS } from '../domain/entitlements';
import { getProfile } from '../repositories/profile.repository';
import { savePreparedInlineMessage, savePreparedKeyboardButton, TelegramApiError } from '../telegram/client';
import { familyInviteLink, inviteShareArticle, pickButtonText } from '../telegram/familyInvite';
import { normalizeLanguage } from '../telegram/i18n';
import { getIsPremium } from './entitlement.service';
import { verifyTelegramInitData } from './telegramVerify.service';
import { AppError } from '../utils/AppError';

type Row = Record<string, any>;

const households = () => db.collection('households');
const invites = () => db.collection('householdInvites');
const cards = () => db.collection('cards');
const transactions = () => db.collection('transactions');
const categories = () => db.collection('categories');
const budgets = () => db.collection('budgets');
const invitePicks = () => db.collection('householdInvitePicks');

const INVITE_PICK_TTL_MS = 60 * 60 * 1000;
/** Bot invitations a household may prepare per day; keeps the bot from being used for spam. */
const INVITE_PICKS_PER_DAY = 20;

async function displayName(uid: string): Promise<string> {
  const profile = await db.collection('profiles').doc(uid).get();
  return String(profile.data()?.name || 'Участник');
}

export async function currentHousehold(uid: string): Promise<Row | null> {
  const snap = await households().where('memberIds', 'array-contains', uid).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

export async function requireHousehold(uid: string): Promise<Row> {
  const household = await currentHousehold(uid);
  if (!household) throw AppError.notFound('Совместный бюджет не найден.');
  return household;
}

export async function createHousehold(uid: string, input: { name: string; currency: string }): Promise<Row> {
  if (await currentHousehold(uid)) {
    throw new AppError(409, 'HOUSEHOLD_EXISTS', 'Вы уже состоите в совместном бюджете.');
  }
  const now = Date.now();
  const name = await displayName(uid);
  const ref = households().doc();
  const household = {
    name: input.name.trim(),
    currency: input.currency,
    ownerUserId: uid,
    memberIds: [uid],
    members: [{ userId: uid, name, role: 'owner', joinedAt: now }],
    createdAt: now,
    updatedAt: now,
  };
  const batch = db.batch();
  batch.create(ref, household);
  for (const category of DEFAULT_CATEGORIES) {
    const id = defaultCategoryId(`household_${ref.id}`, category.type, category.name);
    batch.set(categories().doc(id), { ...category, householdId: ref.id, createdAt: now });
  }
  await batch.commit();
  return { id: ref.id, ...household };
}

export async function updateHousehold(uid: string, input: { name?: string }): Promise<Row> {
  const household = await requireHousehold(uid);
  if (household.ownerUserId !== uid) {
    throw AppError.forbidden('HOUSEHOLD_OWNER_REQUIRED', 'Только владелец может менять настройки.');
  }
  const patch = { ...(input.name ? { name: input.name.trim() } : {}), updatedAt: Date.now() };
  await households().doc(household.id).set(patch, { merge: true });
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
  await invites().doc(token).create(invite);
  return { token, householdName: household.name, expiresAt: invite.expiresAt, link: familyInviteLink(token) };
}

async function ownPendingInvite(uid: string, token: string): Promise<{ household: Row; invite: Row }> {
  const household = await requireHousehold(uid);
  const snap = await invites().doc(token).get();
  const invite = snap.data();
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
    telegramId = String((JSON.parse(parsed.user ?? '{}') as { id?: number | string }).id ?? '');
  } catch {
    telegramId = '';
  }
  if (!telegramId) throw new AppError(401, 'TELEGRAM_AUTH_FAILED', 'Откройте Pulim в Telegram.');
  const mapping = (await db.collection('telegramUsers').doc(telegramId).get()).data();
  if ((mapping?.profileUid ?? mapping?.uid) !== uid) {
    throw AppError.forbidden('TELEGRAM_ACCOUNT_MISMATCH', 'Этот Telegram не привязан к вашему аккаунту.');
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
      throw new AppError(502, 'TELEGRAM_UNAVAILABLE', 'Telegram сейчас недоступен. Попробуйте ещё раз.');
    }
    throw error;
  }
}

async function takeInvitePickQuota(householdId: string): Promise<void> {
  const ref = households().doc(householdId);
  const day = new Date().toISOString().slice(0, 10);
  await db.runTransaction(async (tx) => {
    const quota = (await tx.get(ref)).data()?.invitePickQuota as { day?: string; count?: number } | undefined;
    const count = quota?.day === day ? quota.count ?? 0 : 0;
    if (count >= INVITE_PICKS_PER_DAY) {
      throw new AppError(429, 'INVITE_LIMIT', 'Слишком много приглашений за сегодня. Попробуйте завтра.');
    }
    tx.update(ref, { invitePickQuota: { day, count: count + 1 } });
  });
}

/**
 * Prepares the Telegram contact picker for an invite. The picked partner reaches the
 * bot as a `users_shared` message, handled by the family invite bot handler.
 */
export async function prepareInvitePick(uid: string, token: string, telegramInitData: string): Promise<Row> {
  const { household } = await ownPendingInvite(uid, token);
  if ((household.memberIds ?? []).length >= 2) {
    throw new AppError(409, 'HOUSEHOLD_FULL', 'В этом совместном бюджете уже два участника.');
  }
  const telegramId = await miniAppTelegramId(uid, telegramInitData);
  const language = await profileLanguage(uid);
  await takeInvitePickQuota(household.id);
  const requestId = randomInt(1, 2 ** 31 - 1);
  const prepared = await withTelegram(() => savePreparedKeyboardButton(telegramId, {
    text: pickButtonText(language),
    request_users: { request_id: requestId, user_is_bot: false, max_quantity: 1, request_name: true, request_username: true },
  }));
  const now = Date.now();
  await invitePicks().doc(`${telegramId}_${requestId}`).create({
    token,
    uid,
    householdId: household.id,
    createdAt: now,
    expiresAt: now + INVITE_PICK_TTL_MS,
  });
  await invites().doc(token).update({ delivery: { status: 'awaiting_pick', updatedAt: now } });
  return { buttonId: prepared.id };
}

/** Prepares the invite card the Mini App sends to a chat of the user's choice. */
export async function prepareInviteShare(uid: string, token: string, telegramInitData: string): Promise<Row> {
  const { household } = await ownPendingInvite(uid, token);
  const telegramId = await miniAppTelegramId(uid, telegramInitData);
  const language = await profileLanguage(uid);
  const prepared = await withTelegram(() => savePreparedInlineMessage(
    telegramId,
    inviteShareArticle(language, household.name, token),
    { allow_user_chats: true },
  ));
  return { messageId: prepared.id };
}

export async function inviteStatus(uid: string, token: string): Promise<Row> {
  const household = await requireHousehold(uid);
  const snap = await invites().doc(token).get();
  const invite = snap.data();
  if (!snap.exists || !invite || invite.householdId !== household.id) {
    throw AppError.notFound('Приглашение не найдено.');
  }
  return { token, status: invite.status, expiresAt: invite.expiresAt, delivery: invite.delivery ?? null };
}

/** Single-use: resolves a contact pick back to its invite, or null when stale. */
export async function consumeInvitePick(
  telegramId: string,
  requestId: number,
): Promise<{ token: string; inviterUid: string; household: Row } | null> {
  const ref = invitePicks().doc(`${telegramId}_${requestId}`);
  const pick = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    tx.delete(ref);
    return snap.data()!;
  });
  if (!pick || pick.expiresAt < Date.now()) return null;
  const [inviteSnap, householdSnap] = await Promise.all([
    invites().doc(String(pick.token)).get(),
    households().doc(String(pick.householdId)).get(),
  ]);
  const invite = inviteSnap.data();
  const household = householdSnap.data();
  if (!invite || invite.status !== 'pending' || invite.expiresAt < Date.now()) return null;
  if (!household || (household.memberIds ?? []).length >= 2) return null;
  return { token: String(pick.token), inviterUid: String(pick.uid), household: { id: householdSnap.id, ...household } };
}

export async function recordInviteDelivery(
  token: string,
  delivery: { status: 'delivered' | 'not_delivered'; recipientName: string },
): Promise<void> {
  await invites().doc(token).update({ delivery: { ...delivery, updatedAt: Date.now() } });
}


export async function inviteInfo(token: string): Promise<Row> {
  const snap = await invites().doc(token).get();
  if (!snap.exists) throw AppError.notFound('Приглашение не найдено.');
  const invite = snap.data()!;
  if (invite.status !== 'pending' || invite.expiresAt < Date.now()) {
    throw new AppError(410, 'INVITE_EXPIRED', 'Приглашение больше не действует.');
  }
  const household = await households().doc(invite.householdId).get();
  if (!household.exists) throw AppError.notFound('Совместный бюджет не найден.');
  return {
    token,
    householdId: household.id,
    householdName: household.data()!.name,
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
  const inviteRef = invites().doc(token);
  const householdRef = households().doc(info.householdId);
  await db.runTransaction(async (tx) => {
    const [inviteSnap, householdSnap] = await Promise.all([tx.get(inviteRef), tx.get(householdRef)]);
    if (!inviteSnap.exists || inviteSnap.data()!.status !== 'pending' || inviteSnap.data()!.expiresAt < Date.now()) {
      throw new AppError(410, 'INVITE_EXPIRED', 'Приглашение больше не действует.');
    }
    if (!householdSnap.exists) throw AppError.notFound('Совместный бюджет не найден.');
    const data = householdSnap.data()!;
    if ((data.memberIds ?? []).length >= 2) {
      throw new AppError(409, 'HOUSEHOLD_FULL', 'В этом совместном бюджете уже два участника.');
    }
    const now = Date.now();
    tx.update(householdRef, {
      memberIds: FieldValue.arrayUnion(uid),
      members: FieldValue.arrayUnion({ userId: uid, name: memberName, role: 'member', joinedAt: now }),
      updatedAt: now,
    });
    tx.update(inviteRef, { status: 'accepted', acceptedBy: uid, acceptedAt: now });
  });
  return requireHousehold(uid);
}

export async function listHouseholdCategories(uid: string): Promise<Row[]> {
  const household = await requireHousehold(uid);
  const snap = await categories().where('householdId', '==', household.id).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function listHouseholdBudgets(uid: string): Promise<Row[]> {
  const household = await requireHousehold(uid);
  const snap = await budgets().where('householdId', '==', household.id).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function setHouseholdBudget(
  uid: string,
  categoryId: string,
  input: { amount: number; currency: string },
): Promise<Row> {
  const household = await requireHousehold(uid);
  const category = await categories().doc(categoryId).get();
  if (!category.exists || category.data()!.householdId !== household.id) {
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
  await budgets().doc(id).set(row, { merge: true });
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
    cards().where('householdId', '==', household.id).get(),
    cards().where('familyAccess.householdId', '==', household.id).get(),
  ]);
  const rows: Row[] = [
    ...sharedSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }) as Row),
    ...personalSnap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }) as Row)
      .filter(card => card.familyAccess?.enabled === true),
  ];
  return rows.map(card => cardDto(card, household, uid));
}

export async function createHouseholdCard(uid: string, input: Row): Promise<Row> {
  const household = await requireHousehold(uid);
  // Shared accounts follow the same free-plan limits as personal ones (see enforceLimit).
  if (!(await getIsPremium(uid))) {
    const count = (await cards().where('householdId', '==', household.id).count().get()).data().count;
    if (count >= FREE_LIMITS.cards) {
      throw AppError.forbidden('LIMIT_REACHED', `The free plan allows ${FREE_LIMITS.cards} cards.`);
    }
    if (!FREE_LIMITS.allowedCardTypes.includes(input.cardType)) {
      throw AppError.forbidden('PREMIUM_REQUIRED', 'The free plan allows debit cards only.');
    }
  }
  const ref = cards().doc();
  const row = {
    ...input,
    scope: 'household',
    householdId: household.id,
    createdBy: uid,
    userId: `household:${household.id}`,
    createdAt: Date.now(),
  };
  await ref.create(row);
  return cardDto({ id: ref.id, ...row }, household, uid);
}

export async function setCardFamilyAccess(
  uid: string,
  cardId: string,
  input: { enabled: boolean; showBalance: boolean },
): Promise<Row> {
  const household = await requireHousehold(uid);
  const ref = cards().doc(cardId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.userId !== uid || snap.data()!.scope === 'household') {
    throw AppError.notFound('Личный счёт не найден.');
  }
  const familyAccess = input.enabled
    ? { householdId: household.id, enabled: true, showBalance: input.showBalance, updatedAt: Date.now() }
    : FieldValue.delete();
  await ref.update({ familyAccess });
  const updated = await ref.get();
  return { id: updated.id, ...updated.data() };
}

async function allowedCard(
  tx: FirebaseFirestore.Transaction,
  householdId: string,
  cardId?: string,
): Promise<{ ref: FirebaseFirestore.DocumentReference; data: Row } | null> {
  if (!cardId) return null;
  const ref = cards().doc(cardId);
  const snap = await tx.get(ref);
  if (!snap.exists) throw AppError.notFound('Счёт не найден.');
  const data = snap.data()!;
  const shared = data.scope === 'household' && data.householdId === householdId;
  const personal = data.familyAccess?.enabled === true && data.familyAccess?.householdId === householdId;
  if (!shared && !personal) throw AppError.forbidden('CARD_NOT_SHARED', 'Этот счёт недоступен семье.');
  return { ref, data };
}

export async function listHouseholdTransactions(uid: string): Promise<Row[]> {
  const household = await requireHousehold(uid);
  const snap = await transactions().where('householdId', '==', household.id).get();
  return snap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }) as Row)
    .sort((a, b) => (b.date ?? 0) - (a.date ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function createHouseholdTransaction(uid: string, input: Row): Promise<Row> {
  const household = await requireHousehold(uid);
  const category = await categories().doc(String(input.categoryId)).get();
  if (!category.exists || category.data()!.householdId !== household.id) {
    throw AppError.notFound('Категория не найдена.');
  }
  const categoryData = category.data()!;
  return db.runTransaction(async (tx) => {
    const card = await allowedCard(tx, household.id, input.cardId);
    const ref = transactions().doc();
    const now = Date.now();
    // With no selected account, the creator paid from their own untracked money.
    // It still belongs in their personal ledger, but it does not move a card balance.
    const accountOwnerId = card?.data.scope === 'household' ? undefined : (card?.data.userId ?? uid);
    const row = {
      ...input,
      categoryName: categoryData.name,
      categoryIcon: categoryData.icon,
      categoryColor: categoryData.color,
      scope: 'household',
      householdId: household.id,
      createdBy: uid,
      createdByName: memberName(household, uid),
      ...(accountOwnerId ? {
        accountOwnerId,
        accountOwnerName: memberName(household, accountOwnerId),
      } : {}),
      userId: accountOwnerId ?? `household:${household.id}`,
      createdAt: now,
    };
    tx.create(ref, row);
    if (card) {
      tx.update(card.ref, {
        balance: FieldValue.increment(balanceDelta(card.data.cardType, input.type, input.amount)),
      });
    }
    return { id: ref.id, ...row };
  });
}

export async function deleteHouseholdTransaction(uid: string, id: string): Promise<void> {
  const household = await requireHousehold(uid);
  await db.runTransaction(async (tx) => {
    const ref = transactions().doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()!.householdId !== household.id) {
      throw AppError.notFound('Операция не найдена.');
    }
    const row = snap.data()!;
    const cardRef = row.cardId ? cards().doc(String(row.cardId)) : null;
    const cardSnap = cardRef ? await tx.get(cardRef) : null;
    const cardData = cardSnap?.exists ? cardSnap.data()! : null;
    const isOriginalSource = cardData && (
      (cardData.scope === 'household' && cardData.householdId === household.id)
      || (row.accountOwnerId && cardData.userId === row.accountOwnerId)
    );
    if (cardRef && cardData && isOriginalSource) {
      tx.update(cardRef, {
        balance: FieldValue.increment(-balanceDelta(cardData.cardType, row.type, row.amount)),
      });
    }
    tx.delete(ref);
  });
}
