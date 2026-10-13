import { documentKey, patchValue, runSqlTransaction } from '../db/documents';
import { AppError } from '../utils/AppError';
import { balanceDelta } from '../domain/balance';
import { cardsCol, newTxnRef, readOwned } from '../repositories/sql.helpers';
type Row = Record<string, any>;
/** Pay down a credit card's debt from a debit/cash card. Recorded as one transfer transaction. */
export async function refillCreditCard(
  uid: string,
  input: {
    creditCardId: string;
    sourceCardId: string;
    amount: number;
  },
): Promise<Row> {
  if (input.creditCardId === input.sourceCardId) {
    throw AppError.badRequest('Source and credit card must differ.');
  }
  return runSqlTransaction(async (tx) => {
    const credit = await readOwned(
      tx,
      documentKey(cardsCol(), input.creditCardId),
      uid,
      'Credit card not found.',
    );
    const source = await readOwned(
      tx,
      documentKey(cardsCol(), input.sourceCardId),
      uid,
      'Source card not found.',
    );
    if (credit.data.cardType !== 'credit') {
      throw AppError.badRequest('Target card must be a credit card.');
    }
    const ref = newTxnRef();
    const doc = {
      type: 'expense',
      amount: input.amount,
      currency: credit.data.currency,
      toCardId: input.creditCardId,
      toAmount: input.amount,
      toCurrency: credit.data.currency,
      categoryId: '',
      source: 'transfer',
      sourceLabel: `Refill: ${source.data.name} -> ${credit.data.name}`,
      cardId: input.sourceCardId,
      date: Date.now(),
      userId: uid,
      createdAt: Date.now(),
    };
    tx.save(ref, doc);
    tx.patch(source.ref, {
      balance: patchValue.increment(balanceDelta(source.data.cardType, 'expense', input.amount)),
    });
    // Paying a credit card is "income" to it (reduces debt).
    tx.patch(credit.ref, {
      balance: patchValue.increment(balanceDelta('credit', 'income', input.amount)),
    });
    return { id: ref.id, ...doc };
  });
}
