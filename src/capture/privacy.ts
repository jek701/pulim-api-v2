/** Shared receipt text must never become a backdoor for buyer contact/payment details. */
export function receiptText(value: string): string {
  return value
    .replace(/(?:buyer|customer|покупатель|клиент|харидор|телефон|phone|card|карта|karta)\s*[:=][^\n;]*/giu, '')
    .replace(/\+?\d(?:[\s().*-]*\d){8,}/gu, '[redacted]')
    .trim().slice(0, 300);
}
