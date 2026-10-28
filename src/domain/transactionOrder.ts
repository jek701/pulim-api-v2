/**
 * List order of transactions: newest day first, and inside a day the most recently ADDED first
 * (`createdAt desc`), whatever kind of transaction it is.
 *
 * `date` is not comparable inside a day: a plain expense stores UTC midnight of the picked day,
 * while transfers, refunds, payments and bot entries store the moment of the operation. Comparing
 * raw `date` therefore pins the ones with a clock time above the ones without, regardless of the
 * order they were added in. The day is taken in the app's home timezone (Uzbekistan, UTC+5, no DST),
 * the same day the clients group by.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

export const transactionDay = (date: number | undefined): number =>
  Math.floor(((date ?? 0) + TASHKENT_OFFSET_MS) / DAY_MS);

type Ordered = { date?: number; createdAt?: number; id?: string };

export function compareTransactions(a: Ordered, b: Ordered): number {
  return (
    transactionDay(b.date) - transactionDay(a.date) ||
    (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
    (b.date ?? 0) - (a.date ?? 0)
  );
}
