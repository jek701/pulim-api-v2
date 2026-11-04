export interface ParsedAmount {
  amount: number | null;
  currency: string;
  confidence: 'high' | 'low';
  reason?: 'missing' | 'ambiguous' | 'invalid';
}

export interface ParsedAmountSpan extends ParsedAmount {
  text: string;
  start: number;
  end: number;
}

const numbers = new Map<string, number>();
const addNumbers = (values: string[], amounts: number[]) => {
  values.forEach((aliases, i) =>
    aliases.split('|').forEach((word) => numbers.set(word, amounts[i])),
  );
};

addNumbers(
  [
    'zero|ноль|нуль|nol|нол',
    'one|один|одна|одно|bir|бир',
    'two|два|две|ikki|икки',
    'three|три|uch|уч',
    "four|четыре|to'rt|торт|тўрт",
    'five|пять|besh|беш',
    'six|шесть|olti|олти',
    'seven|семь|yetti|етти',
    'eight|восемь|sakkiz|саккиз',
    "nine|девять|to'qqiz|тўққиз|туккиз",
    "ten|десять|o'n|он|ўн",
    'eleven|одиннадцать',
    'twelve|двенадцать',
    'thirteen|тринадцать',
    'fourteen|четырнадцать',
    'fifteen|пятнадцать',
    'sixteen|шестнадцать',
    'seventeen|семнадцать',
    'eighteen|восемнадцать',
    'nineteen|девятнадцать',
  ],
  Array.from({ length: 20 }, (_, i) => i),
);
addNumbers(
  [
    'twenty|двадцать|yigirma|йигирма',
    "thirty|тридцать|o'ttiz|ўттиз|уттиз",
    'forty|сорок|qirq|қирқ|кирк',
    'fifty|пятьдесят|ellik|эллик',
    'sixty|шестьдесят|oltmish|олтмиш',
    'seventy|семьдесят|yetmish|етмиш',
    'eighty|восемьдесят|sakson|саксон',
    "ninety|девяносто|to'qson|тўқсон|туксон",
  ],
  [20, 30, 40, 50, 60, 70, 80, 90],
);
addNumbers(
  [
    'сто',
    'двести',
    'триста',
    'четыреста',
    'пятьсот',
    'шестьсот',
    'семьсот',
    'восемьсот',
    'девятьсот',
    'полтора|полторы',
    'полтысячи',
    'полмиллиона',
    'полмиллиарда',
  ],
  [100, 200, 300, 400, 500, 600, 700, 800, 900, 1.5, 500, 500_000, 500_000_000],
);

const scales = new Map<string, number>();
for (const [aliases, value] of [
  ['hundred|hundreds|yuz|юз', 100],
  ['k|к|тыс|тысяча|тысячи|тысяч|thousand|thousands|ming|минг', 1_000],
  ['m|м|млн|миллион|миллиона|миллионов|million|millions|mln|миллион', 1_000_000],
  ['b|млрд|миллиард|миллиарда|миллиардов|billion|billions|milliard|mlrd', 1_000_000_000],
] as const) {
  aliases.split('|').forEach((word) => scales.set(word, value));
}

const currencies = new Map<string, string>();
for (const [code, aliases] of [
  ['UZS', "uzs|сум|сума|сумов|сўм|som|so'm|sum"],
  ['USD', 'usd|$|доллар|доллара|долларов|долл|бакс|бакса|баксов|dollar|dollars|dollarlar'],
  ['EUR', 'eur|€|евро|euro|euros|yevro'],
  ['RUB', 'rub|₽|руб|рубль|рубля|рублей|rubl|rubles|roubles'],
  ['GBP', 'gbp|£|pound|pounds|фунт|фунтов'],
  ['KZT', 'kzt|₸|тенге|tenge'],
  ['CNY', 'cny|юань|юаней|yuan'],
  ['TRY', 'try|₺|lira|лира|лир'],
  ['AED', 'aed|dirham|dirhams|дирхам|дирхамов'],
  ['JPY', 'jpy|¥|yen|иен|йен'],
] as const) {
  aliases.split('|').forEach((word) => currencies.set(word, code));
}

const halves = new Set(['half', 'yarim', 'ярим', 'половиной', 'половина']);
const connectors = new Set(['and', 'a', 'с', 'и', 'va', 'ва']);
const negatives = new Set(['minus', 'минус', 'manfiy', 'манфий']);
const decimalWords = new Set(['point', 'dot', 'точка', 'запятая', 'butun', 'бутун']);
const numeric = /^[+-]?\d[\d\s.,]*(?:e[+-]?\d+)?$/;

interface Token {
  word: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  // Keep offsets in the original text: spans are checked against the transcription, not model numbers.
  const pattern =
    /[+-]?\d+(?:[.,]\d+)*(?:[ \u00a0\u202f]\d{3}(?!\d))*(?:[.,]\d+)*(?:[eE][+-]?\d+)?|[\p{L}]+(?:['’ʻʼ‘`][\p{L}]+)*|[$€₽£₸₺¥]/gu;
  return Array.from(text.matchAll(pattern), (match) => ({
    word: match[0].toLowerCase().replace(/[’ʻʼ‘`]/g, "'"),
    start: match.index!,
    end: match.index! + match[0].length,
  }));
}

function parseNumeric(word: string): number {
  let value = word.replace(/\s/g, '');
  if (/[eE]/.test(value)) return Number.NaN;
  if (/^[+-]?[1-9]\d{0,2}(?:[.,]\d{3})+$/.test(value)) {
    value = value.replace(/[.,]/g, '');
  } else if (value.includes(',') && value.includes('.')) {
    const decimal = Math.max(value.lastIndexOf(','), value.lastIndexOf('.'));
    const integer = value.slice(0, decimal);
    const separator = integer.includes(',') ? ',' : '.';
    if (!new RegExp(`^[+\\-]?\\d{1,3}(?:\\${separator}\\d{3})+$`).test(integer)) return Number.NaN;
    value = `${integer.replace(/[.,]/g, '')}.${value.slice(decimal + 1)}`;
  } else {
    value = value.replace(',', '.');
  }
  return Number(value);
}

function isNumber(word: string): boolean {
  return numeric.test(word) || numbers.has(word) || scales.has(word) || halves.has(word);
}

function evaluate(words: string[]): number | null {
  let total = 0;
  let group = 0;
  let groupPresent = false;
  let lastScale = Infinity;
  let previousValue: number | null = null;
  let hadHalf = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (connectors.has(word)) continue;
    if (negatives.has(word)) return null;
    if (decimalWords.has(word)) {
      let fraction = '';
      while (i + 1 < words.length) {
        const next = words[i + 1];
        const digit = numbers.get(next) ?? (/^\d$/.test(next) ? Number(next) : undefined);
        if (digit === undefined || digit > 9) break;
        fraction += String(digit);
        i++;
      }
      if (!fraction || group % 1 !== 0) return null;
      group += Number(`0.${fraction}`);
      groupPresent = true;
      previousValue = null;
      continue;
    }
    if (halves.has(word)) {
      if (hadHalf) return null;
      group += 0.5;
      groupPresent = true;
      hadHalf = true;
      previousValue = null;
      continue;
    }
    const scale = scales.get(word);
    if (scale !== undefined) {
      if (groupPresent && group === 0) return null;
      if (scale === 100) {
        if (group >= 100 || (group && group % 1 !== 0)) return null;
        group = (group || 1) * scale;
        groupPresent = true;
      } else {
        if (scale >= lastScale) return null;
        total += (group || 1) * scale;
        group = 0;
        groupPresent = false;
        lastScale = scale;
      }
      previousValue = null;
      hadHalf = false;
      continue;
    }
    const value = numbers.get(word) ?? parseNumeric(word);
    if (!Number.isFinite(value) || value < 0) return null;
    // Adjacent units or numeric literals are separate amounts, never an invented sum.
    if (
      previousValue !== null &&
      (numeric.test(word) || value >= previousValue || previousValue < 10)
    )
      return null;
    group += value;
    groupPresent = true;
    previousValue = value;
  }
  const cents = (total + group) * 100;
  if (Math.abs(cents - Math.round(cents)) > 0.000001) return null;
  const amount = Math.round(cents) / 100;
  return amount > 0 && amount <= 1e15 ? amount : null;
}

/** Extract independent amounts without guessing an omitted scale or using model arithmetic. */
export function parseAmounts(text: string): ParsedAmountSpan[] {
  const tokens = tokenize(text.replace(/[−–—]/g, '-'));
  const results: ParsedAmountSpan[] = [];
  // Dates and clock times are context, not money. The pipeline normally supplies an amount span.
  const dateRanges = Array.from(
    text.matchAll(/\d{1,4}[-/:.]\d{1,2}(?:[-/.]\d{2,4})?|\d{1,2}:\d{2}/g),
  )
    .filter((m) => /[-/:]/.test(m[0]) || (m[0].match(/\./g)?.length ?? 0) === 2)
    .map((m) => [m.index!, m.index! + m[0].length]);
  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i];
    if (!isNumber(first.word) && !negatives.has(first.word)) continue;
    if (dateRanges.some(([start, end]) => first.start >= start && first.start < end)) continue;
    let endIndex = i;
    while (endIndex + 1 < tokens.length) {
      const next = tokens[endIndex + 1];
      const gap = text.slice(tokens[endIndex].end, next.start);
      if (/[,;!?\n]/.test(gap)) break;
      if (isNumber(next.word) || decimalWords.has(next.word)) {
        endIndex++;
        continue;
      }
      if (connectors.has(next.word)) {
        let following = endIndex + 2;
        while (following < tokens.length && connectors.has(tokens[following].word)) following++;
        if (following < tokens.length && isNumber(tokens[following].word)) {
          endIndex++;
          continue;
        }
      }
      break;
    }
    const words = tokens.slice(i, endIndex + 1).map((token) => token.word);
    const before = tokens[i - 1];
    const after = tokens[endIndex + 1];
    const prefixCurrency = before && currencies.get(before.word);
    const suffixCurrency = after && currencies.get(after.word);
    const currency = suffixCurrency || prefixCurrency || 'UZS';
    const conflicting = prefixCurrency && suffixCurrency && prefixCurrency !== suffixCurrency;
    const amount = conflicting ? null : evaluate(words);
    const explicit =
      words.some((word) => scales.has(word) || word.startsWith('пол')) ||
      !!(prefixCurrency || suffixCurrency);
    const ambiguous = amount !== null && currency === 'UZS' && amount < 1_000 && !explicit;
    const start = prefixCurrency ? before.start : first.start;
    const end = suffixCurrency ? after.end : tokens[endIndex].end;
    results.push({
      amount,
      currency,
      confidence: amount === null || ambiguous ? 'low' : 'high',
      ...(amount === null
        ? { reason: conflicting ? ('ambiguous' as const) : ('invalid' as const) }
        : ambiguous
          ? { reason: 'ambiguous' as const }
          : {}),
      text: text.slice(start, end),
      start,
      end,
    });
    i = endIndex;
  }
  return results;
}

/** Parse a model-selected source span. Multiple amounts require separate spans, never a guess. */
export function parseAmount(text: string): ParsedAmount {
  const amounts = parseAmounts(text);
  if (amounts.length !== 1) {
    return {
      amount: null,
      currency: 'UZS',
      confidence: 'low',
      reason: amounts.length ? 'ambiguous' : 'missing',
    };
  }
  const { amount, currency, confidence, reason } = amounts[0];
  return { amount, currency, confidence, ...(reason ? { reason } : {}) };
}
