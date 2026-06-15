import { db, FieldValue } from '../config/firebase';
import { balanceDelta } from '../domain/balance';
import { calcDebtTotal } from '../domain/debt';
import { cardsCol, debtsCol, newTxnRef, readOwned } from '../repositories/firestore.helpers';
import type { Commission } from '../domain/types';

type Row = Record<string, any>;

interface CreateDebtInput {
  direction: 'i_owe' | 'owe_me';
  person: string;
  amount: number;
  currency: string;
  commission?: Commission;
  dueDate?: number;
  comment?: string;
  accountId?: string;
}

/** Create a debt and, if an account is chosen, record the initial cash movement atomically. */
export async function createDebt(uid: string, input: CreateDebtInput): Promise<Row> {
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const account = input.accountId
      ? await readOwned(tx, cardsCol().doc(input.accountId), uid, 'Account not found.')
      : null;

    const debtRef = debtsCol().doc();
    const debtDoc = {
      direction: input.direction,
      person: input.person,
      amount: input.amount,
      paidAmount: 0,
      currency: input.currency,
      commission: input.commission,
      dueDate: input.dueDate,
      comment: input.comment,
      isPaid: false,
      userId: uid,
      createdAt: now,
    };
    tx.set(debtRef, debtDoc);

    if (account) {
      // i_owe: you receive money now (income). owe_me: you hand money out (expense).
      const txType = input.direction === 'i_owe' ? 'income' : 'expense';
      const ref = newTxnRef();
      tx.set(ref, {
        type: txType, amount: input.amount, currency: input.currency, categoryId: '',
        source: 'debt_payment', sourceLabel: `Debt: ${input.person}`,
        cardId: account.ref.id, date: now, userId: uid, createdAt: now,
      });
      tx.update(account.ref, {
        balance: FieldValue.increment(balanceDelta(account.data.cardType, txType, input.amount)),
      });
    }
    return { id: debtRef.id, ...debtDoc };
  });
}

/** Record a (partial) debt payment, auto-completing when paid amount reaches the commission-adjusted total. */
export async function payDebt(uid: string, debtId: string, amount: number, accountId?: string): Promise<Row> {
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const debt = await readOwned(tx, debtsCol().doc(debtId), uid, 'Debt not found.');
    const account = accountId ? await readOwned(tx, cardsCol().doc(accountId), uid, 'Account not found.') : null;

    const total = calcDebtTotal(debt.data.amount, debt.data.commission);
    const newPaid = (debt.data.paidAmount || 0) + amount;
    // owe_me: they repay you (income). i_owe: you repay them (expense).
    const txType = debt.data.direction === 'owe_me' ? 'income' : 'expense';

    const patch: Record<string, unknown> = { paidAmount: FieldValue.increment(amount) };
    if (newPaid >= total) patch.isPaid = true;
    tx.update(debt.ref, patch);

    const ref = newTxnRef();
    tx.set(ref, {
      type: txType, amount, currency: debt.data.currency, categoryId: '',
      source: 'debt_payment', sourceLabel: `Debt: ${debt.data.person}`,
      ...(accountId ? { cardId: accountId } : {}), date: now, userId: uid, createdAt: now,
    });
    if (account) {
      tx.update(account.ref, { balance: FieldValue.increment(balanceDelta(account.data.cardType, txType, amount)) });
    }
    return { id: debtId, paidAmount: newPaid, isPaid: newPaid >= total, total };
  });
}
