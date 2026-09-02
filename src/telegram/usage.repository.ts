import { db, FieldValue } from '../config/firebase';
import { env } from '../config/env';

function dayKey(now: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env.TELEGRAM_DEFAULT_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
}

export async function consumeParse(
  uid: string,
  operationKey: string,
  isPremium: boolean,
): Promise<'minute' | 'day' | null> {
  const ref = db.collection('telegramUsage').doc(uid);
  const dailyLimit = isPremium
    ? env.TELEGRAM_PARSE_DAILY_LIMIT_PREMIUM
    : env.TELEGRAM_PARSE_DAILY_LIMIT_FREE;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.data() ?? {};
    const now = Date.now();
    const day = dayKey(now);
    const sameDay = current.day === day;
    const processedKeys = sameDay && Array.isArray(current.processedKeys) ? current.processedKeys as string[] : [];
    if (processedKeys.includes(operationKey)) return null;
    const parsedToday = sameDay ? Number(current.parsedToday ?? 0) : 0;
    const minuteWindowStart = Number(current.minuteWindowStart ?? 0);
    const sameMinute = now - minuteWindowStart < 60_000;
    const minuteCount = sameMinute ? Number(current.minuteCount ?? 0) : 0;
    if (minuteCount >= env.TELEGRAM_PARSE_PER_MINUTE_LIMIT) return 'minute';
    if (parsedToday >= dailyLimit) return 'day';
    tx.set(ref, {
      userId: uid,
      day,
      parsedToday: parsedToday + 1,
      minuteWindowStart: sameMinute ? minuteWindowStart : now,
      minuteCount: minuteCount + 1,
      processedKeys: [...processedKeys, operationKey].slice(-dailyLimit),
      updatedAt: now,
    }, { merge: true });
    return null;
  });
}

export async function refundParse(uid: string, operationKey: string): Promise<void> {
  const ref = db.collection('telegramUsage').doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const current = snap.data()!;
    tx.set(ref, {
      parsedToday: Math.max(0, Number(current.parsedToday ?? 0) - 1),
      minuteCount: Math.max(0, Number(current.minuteCount ?? 0) - 1),
      processedKeys: FieldValue.arrayRemove(operationKey),
      updatedAt: Date.now(),
    }, { merge: true });
  });
}
