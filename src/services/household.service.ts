import { randomBytes } from 'node:crypto';
import { db, FieldValue } from '../config/firebase';
import { DEFAULT_CATEGORIES, defaultCategoryId } from '../domain/defaultCategories';
import { balanceDelta } from '../domain/balance';
import { FREE_LIMITS } from '../domain/entitlements';
import { getIsPremium } from './entitlement.service';
import { AppError } from '../utils/AppError';

type Row = Record<string, any>;

const households = () => db.collection('households');
const invites = () => db.collection('householdInvites');
const cards = () => db.collection('cards');
const transactions = () => db.collection('transactions');
const categories = () => db.collection('categories');
const budgets = () => db.collection('budgets');

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
  return { token, householdName: household.name, expiresAt: invite.expiresAt };
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

function memberName(household: Row, uid: string): string {
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
