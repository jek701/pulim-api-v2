import {
  documentKey,
  filterQuery,
  patchValue,
  queryTable,
  readDocument,
  runSqlTransaction,
  type DocumentKey,
  type SqlTransaction,
} from '../db/documents';
import { balanceDelta } from '../domain/balance';
import { clientNow } from '../domain/clientTime';
import { prunePlanDayKeys } from '../domain/plannedPaid';
import {
  cardsCol,
  readOwned,
  resolveCreateTarget,
  txnsCol,
  writeCreated,
} from '../repositories/sql.helpers';
import { AppError } from '../utils/AppError';

type Row = Record<string, any>;
const plannedCol = () => queryTable('planned_expenses');

const asMap = (value: unknown) => ({ ...(value as Record<string, string> | undefined) });
const asDays = (value: unknown) => [...((value as string[] | undefined) ?? [])];
/** Plan snapshot with the server-managed `linkedDays` always present (missing = empty). */
const snapshot = (id: string, data: Row, patch: Row = {}): Row => ({
  id,
  ...data,
  linkedDays: asDays(data.linkedDays),
  ...patch,
});

/** Attach an existing operation without modifying it or its account balance. */
export async function linkPlannedExpense(
  uid: string,
  planId: string,
  input: { day: string; transactionId: string },
): Promise<Row> {
  return runSqlTransaction(async (tx) => {
    // Lock order: transaction row first, then the target plan (same order as transaction delete).
    const transaction = await tx.read(documentKey(txnsCol(), input.transactionId));
    const planRef = documentKey(plannedCol(), planId);
    const plan = await tx.read(planRef);
    if (!plan.exists || plan.data.userId !== uid)
      throw AppError.notFound('Planned expense not found.');
    // Deleted transactions are physically removed from the transactions table.
    if (!transaction.exists || transaction.data.userId !== uid)
      throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found.');
    if (transaction.data.type !== (plan.data.kind ?? 'expense'))
      throw new AppError(400, 'TRANSACTION_MISMATCH', 'Transaction type does not match the plan kind.');
    // Re-checked on the locked target plan.
    const paid = asMap(plan.data.paid);
    if (paid[input.day] === input.transactionId) return snapshot(planId, plan.data);
    if (paid[input.day])
      throw AppError.conflict('ALREADY_SETTLED', 'This occurrence is already marked as paid.');
    // Non-locking scan (separate read, no row locks on the user's other plans). The locked
    // transaction row serializes concurrent links of this operation, so a competing link has
    // committed before this read.
    const plans = await readDocument(filterQuery(plannedCol(), 'userId', '==', uid));
    const linkedElsewhere =
      Object.values(paid).includes(input.transactionId) ||
      plans.rows.some(
        (p) =>
          p.key.id !== planId &&
          Object.values((p.data.paid ?? {}) as Record<string, string>).includes(input.transactionId),
      );
    if (linkedElsewhere)
      throw AppError.conflict('TRANSACTION_LINKED', 'Transaction is already linked to an occurrence.');
    const updatedPaid = { ...paid, [input.day]: input.transactionId };
    const linkedDays = asDays(plan.data.linkedDays);
    if (!linkedDays.includes(input.day)) linkedDays.push(input.day);
    tx.patch(planRef, { paid: updatedPaid, linkedDays });
    return snapshot(planId, plan.data, { paid: updatedPaid, linkedDays });
  });
}

/** Remove only a link made by `link`; settle-created entries and the operation stay intact. */
export async function unlinkPlannedExpense(
  uid: string,
  planId: string,
  input: { day: string; transactionId: string },
): Promise<Row> {
  return runSqlTransaction(async (tx) => {
    const planRef = documentKey(plannedCol(), planId);
    const plan = await tx.read(planRef);
    if (!plan.exists || plan.data.userId !== uid)
      throw AppError.notFound('Planned expense not found.');
    const paid = asMap(plan.data.paid);
    if (!Object.hasOwn(paid, input.day)) return snapshot(planId, plan.data);
    if (paid[input.day] !== input.transactionId)
      throw AppError.conflict('LINK_MISMATCH', 'This occurrence is linked to another operation.');
    const linkedDays = asDays(plan.data.linkedDays);
    if (!linkedDays.includes(input.day))
      throw AppError.conflict('NOT_LINKED', 'This occurrence was not linked to an existing operation.');
    delete paid[input.day];
    const rest = linkedDays.filter((day) => day !== input.day);
    tx.patch(planRef, { paid, linkedDays: rest });
    return snapshot(planId, plan.data, { paid, linkedDays: rest });
  });
}

/**
 * Called inside the transaction-delete SQL transaction after the deleted transaction row is
 * locked and before any write is scheduled: finds the user's plans whose link points at it
 * (plain, non-locking read), locks only those and returns the patches to apply.
 */
export async function readLinkCleanup(
  tx: SqlTransaction,
  uid: string,
  transactionId: string,
): Promise<Array<{ ref: DocumentKey; patch: Row }>> {
  const dangling = (data: Row) =>
    asDays(data.linkedDays).filter((day) => asMap(data.paid)[day] === transactionId);
  const candidates = await readDocument(filterQuery(plannedCol(), 'userId', '==', uid));
  const patches: Array<{ ref: DocumentKey; patch: Row }> = [];
  for (const candidate of candidates.rows) {
    if (!dangling(candidate.data).length) continue;
    const locked = await tx.read(candidate.key);
    if (!locked.exists || locked.data.userId !== uid) continue;
    const days = dangling(locked.data);
    if (!days.length) continue;
    const paid = asMap(locked.data.paid);
    for (const day of days) delete paid[day];
    patches.push({
      ref: candidate.key,
      patch: { paid, linkedDays: asDays(locked.data.linkedDays).filter((d) => !days.includes(d)) },
    });
  }
  return patches;
}

export interface SettleInput {
  day: string;
  accountId?: string;
  categoryId?: string;
  amount?: number;
  transactionId?: string;
  date?: number;
}

/**
 * "Mark paid / received" for one occurrence of a plan: ONE SQL transaction creates a normal
 * transaction (type = plan kind), applies the account balance exactly like paySubscription and
 * records `paid[day] = transactionId` on the plan.
 */
export async function settlePlannedExpense(uid: string, planId: string, input: SettleInput): Promise<Row> {
  const now = clientNow(input.date);
  return runSqlTransaction(async (tx) => {
    // Replay of an applied settle (offline client id): no second effect.
    const target = await resolveCreateTarget(tx, txnsCol(), uid, input.transactionId);
    const planRef = documentKey(plannedCol(), planId);
    const plan = await readOwned(tx, planRef, uid, 'Planned expense not found.');
    const paid = (plan.data.paid ?? {}) as Record<string, string>;
    if (target.existing) {
      if (paid[input.day] !== target.ref.id)
        throw AppError.conflict('ID_CONFLICT', 'This id cannot be used.');
      return {
        id: planId,
        paid,
        linkedDays: asDays(plan.data.linkedDays),
        transaction: { id: target.ref.id },
      };
    }
    if (paid[input.day])
      throw AppError.conflict('ALREADY_SETTLED', 'This occurrence is already marked as paid.');
    const amount = input.amount ?? (plan.data.amount as number);
    const categoryId = input.categoryId ?? plan.data.categoryId;
    if (!categoryId) throw AppError.badRequest('A category is required.');
    // The request's account is the only one used: the plan's default account is just a pay-sheet preset.
    const accountId = input.accountId;
    const account = accountId
      ? await readOwned(tx, documentKey(cardsCol(), accountId), uid, 'Account not found.')
      : null;
    if (account && account.data.currency !== plan.data.currency)
      throw AppError.badRequest('Account currency does not match the plan currency.');
    const type = plan.data.kind ?? 'expense';
    writeCreated(tx, target, {
      type,
      amount,
      currency: plan.data.currency,
      categoryId,
      comment: plan.data.name,
      ...(account ? { cardId: account.ref.id } : {}),
      date: now,
      userId: uid,
      createdAt: now,
    });
    if (account) {
      tx.patch(account.ref, {
        balance: patchValue.increment(balanceDelta(account.data.cardType, type, amount)),
      });
    }
    const pruned = prunePlanDayKeys({ ...paid, [input.day]: target.ref.id }, plan.data.skipped, now);
    const linkedDays = asDays(plan.data.linkedDays);
    const keptLinked = linkedDays.filter((day) => day in pruned.paid);
    tx.patch(planRef, keptLinked.length === linkedDays.length ? pruned : { ...pruned, linkedDays: keptLinked });
    return { id: planId, paid: pruned.paid, linkedDays: keptLinked, transaction: { id: target.ref.id } };
  });
}
