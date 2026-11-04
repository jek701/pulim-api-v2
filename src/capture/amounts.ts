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
    'one|один|одна|одно|одну|одной|одного|bir|бир',
    'two|два|две|двух|двум|двумя|ikki|икки',
    'three|три|трёх|трех|трём|трем|тремя|uch|уч',
    "four|четыре|четырёх|четырех|четырём|четырем|четырьмя|to'rt|торт|тўрт",
    'five|пять|пяти|пятью|besh|беш',
    'six|шесть|шести|шестью|olti|олти',
    'seven|семь|семи|семью|yetti|етти',
    'eight|восемь|восьми|восемью|sakkiz|саккиз',
    "nine|девять|девяти|девятью|to'qqiz|тўққиз|туккиз",
    "ten|десять|десяти|десятью|o'n|он|ўн",
    'eleven|одиннадцать|одиннадцати',
    'twelve|двенадцать|двенадцати',
    'thirteen|тринадцать|тринадцати',
    'fourteen|четырнадцать|четырнадцати',
    'fifteen|пятнадцать|пятнадцати',
    'sixteen|шестнадцать|шестнадцати',
    'seventeen|семнадцать|семнадцати',
    'eighteen|восемнадцать|восемнадцати',
    'nineteen|девятнадцать|девятнадцати',
  ],
  Array.from({ length: 20 }, (_, i) => i),
);
addNumbers(
  [
    'twenty|двадцать|двадцати|двадцатью|yigirma|йигирма',
    "thirty|тридцать|тридцати|тридцатью|o'ttiz|ўттиз|уттиз",
    'forty|сорок|сорока|qirq|қирқ|кирк',
    'fifty|пятьдесят|пятидесяти|ellik|эллик',
    'sixty|шестьдесят|шестидесяти|oltmish|олтмиш',
    'seventy|семьдесят|семидесяти|yetmish|етмиш',
    'eighty|восемьдесят|восьмидесяти|sakson|саксон',
    "ninety|девяносто|девяноста|to'qson|тўқсон|туксон",
  ],
  [20, 30, 40, 50, 60, 70, 80, 90],
);
addNumbers(
  [
    'сто|ста',
    'двести|двухсот',
    'триста|трёхсот|трехсот',
    'четыреста|четырёхсот|четырехсот',
    'пятьсот|пятисот',
    'шестьсот|шестисот',
    'семьсот|семисот',
    'восемьсот|восьмисот',
    'девятьсот|девятисот',
    'полтора|полторы|полутора',
    'полтысячи',
    'полмиллиона',
    'полмиллиарда',
  ],
  [100, 200, 300, 400, 500, 600, 700, 800, 900, 1.5, 500, 500_000, 500_000_000],
);

const scales = new Map<string, number>();
for (const [aliases, value] of [
  ['hundred|hundreds|yuz|юз', 100],
  ['k|к|тыс|тысяча|тысячу|тысячи|тысяч|тысячам|тысячами|тысячах|тысячей|thousand|thousands|ming|минг', 1_000],
  ['m|м|млн|миллион|миллиона|миллионов|million|millions|mln|миллион', 1_000_000],
  ['b|млрд|миллиард|миллиарда|миллиардов|billion|billions|milliard|mlrd', 1_000_000_000],
] as const) {
  aliases.split('|').forEach((word) => scales.set(word, value));
}

/**
 * Scale words that stand for exactly one unit by themselves ("тысячу двести", "миллион с половиной",
 * "ming yarim"). Every other scale word (k, к, m, м, b, млн, тыс, тысяч, тысячи, миллиона, ...) is
 * only meaningful after a number, so on its own it never parses.
 */
const standsAlone = new Set([
  'hundred', 'yuz', 'юз', 'тысяча', 'тысячу', 'thousand', 'ming', 'минг', 'million', 'миллион',
  'billion', 'миллиард', 'milliard',
]);
const SHORT_ALIASES = new Set(['k', 'к', 'm', 'м', 'b']);
const needsMultiplicand = (word: string): boolean => scales.has(word) && !standsAlone.has(word);

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

const halves = new Set(['half', 'yarim', 'ярим', 'половиной', 'половина', 'пол']);
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

interface Evaluated {
  value: number | null;
  /** The words are readable but their meaning is a guess (decimal-or-thousands, bare scale word). */
  ambiguous: boolean;
}
const NOT_AMOUNT: Evaluated = { value: null, ambiguous: false };

/**
 * Evaluates one number phrase. Never returns a confident wrong number: anything it cannot read
 * exactly (adjacent literals, a scale word without a number, a half after a big multiplier,
 * ranges, scale ordering) is null.
 */
function evaluate(words: string[]): Evaluated {
  let total = 0;
  let group = 0;
  let groupPresent = false;
  let lastScale = Infinity;
  let lastMultiplier: number | null = null;
  let justScaled = false;
  let previousValue: number | null = null;
  let halfOpen = false;
  let ambiguous = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (connectors.has(word)) continue;
    if (negatives.has(word)) return NOT_AMOUNT;
    if (decimalWords.has(word)) {
      let fraction = '';
      while (i + 1 < words.length) {
        const next = words[i + 1];
        const digit = numbers.get(next) ?? (/^\d$/.test(next) ? Number(next) : undefined);
        if (digit === undefined || digit > 9) break;
        fraction += String(digit);
        i++;
      }
      if (!fraction || group % 1 !== 0) return NOT_AMOUNT;
      group += Number(`0.${fraction}`);
      groupPresent = true;
      previousValue = null;
      justScaled = false;
      continue;
    }
    if (halves.has(word)) {
      if (halfOpen) return NOT_AMOUNT;
      if (justScaled) {
        // "миллион с половиной", "ming yarim": half of the scale just spoken, only after 1..9 of it.
        if (lastMultiplier === null || lastMultiplier % 1 !== 0 || lastMultiplier >= 10) return NOT_AMOUNT;
        total += lastScale / 2;
        justScaled = false;
      } else {
        // "полтора"-style leading half ("пол миллиона", "half a million") or "bir yarim".
        group += 0.5;
        groupPresent = true;
      }
      halfOpen = true;
      previousValue = null;
      continue;
    }
    const scale = scales.get(word);
    if (scale !== undefined) {
      if (groupPresent && group === 0) return NOT_AMOUNT;
      if (needsMultiplicand(word) && !(groupPresent && group > 0)) return NOT_AMOUNT;
      if (scale === 100) {
        if (group >= 100 || (group && group % 1 !== 0)) return NOT_AMOUNT;
        group = (group || 1) * scale;
        groupPresent = true;
        justScaled = false;
      } else {
        if (scale >= lastScale) return NOT_AMOUNT;
        lastMultiplier = group || 1;
        total += lastMultiplier * scale;
        group = 0;
        groupPresent = false;
        lastScale = scale;
        justScaled = true;
        halfOpen = false;
      }
      previousValue = null;
      continue;
    }
    if (halfOpen) return NOT_AMOUNT;
    let value = numbers.get(word) ?? parseNumeric(word);
    // "1.250 млн" is a decimal (1.25 million) far more often than 1250 million, but only a guess.
    const next = words[i + 1];
    if (numeric.test(word) && /^[1-9]\d{0,2}[.,]\d{3}$/.test(word) && next !== undefined
      && (scales.get(next) ?? 0) >= 1_000) {
      value = Number(word.replace(',', '.'));
      ambiguous = true;
    }
    if (!Number.isFinite(value) || value < 0) return NOT_AMOUNT;
    // Adjacent units or numeric literals (and ranges like "10-15") are never summed or guessed.
    if (
      previousValue !== null &&
      (numeric.test(word) || value >= previousValue || previousValue < 10)
    )
      return NOT_AMOUNT;
    group += value;
    groupPresent = true;
    previousValue = value;
    justScaled = false;
  }
  const cents = (total + group) * 100;
  if (Math.abs(cents - Math.round(cents)) > 0.000001) return NOT_AMOUNT;
  const amount = Math.round(cents) / 100;
  if (!(amount > 0 && amount <= 1e15)) return NOT_AMOUNT;
  // A lone scale word ("тысяча", "ming") has no stated multiplier.
  const bare = words.filter((word) => !connectors.has(word)).length === 1 && scales.has(words[0]);
  return { value: amount, ambiguous: ambiguous || bare };
}

/** Extract independent amounts without guessing an omitted scale or using model arithmetic. */
export function parseAmounts(text: string): ParsedAmountSpan[] {
  const tokens = tokenize(text.replace(/[−–—]/g, '-'));
  const results: ParsedAmountSpan[] = [];
  // Dates and clock times are context, not money. The pipeline normally supplies an amount span.
  const dateRanges = Array.from(
    text.matchAll(/\d{1,4}[-/:.]\d{1,2}(?:[-/.]\d{2,4})?|\d{1,2}:\d{2}/g),
  )
    // A lone short "10-15" is a range ("10-15 тысяч"), not a date; it must reach the evaluator.
    .filter((m) => m[0].includes(':') || m[0].includes('/') || /^\d{4}[-.]/.test(m[0])
      || (m[0].match(/[-.]/g)?.length ?? 0) >= 2)
    .map((m) => [m.index!, m.index! + m[0].length]);
  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i];
    if (!isNumber(first.word) && !negatives.has(first.word)) continue;
    // "к ужину", "потратил к", a stray "тысяч": scale words need a number before them.
    if (needsMultiplicand(first.word)) {
      // A one-letter alias is just a preposition. A real scale word left without its number
      // ("двадцать пять абв тысяч", "несколько тысяч") means the phrase is broken: not an amount.
      if (!SHORT_ALIASES.has(first.word)) {
        results.push({ amount: null, currency: 'UZS', confidence: 'low', reason: 'invalid',
          text: text.slice(first.start, first.end), start: first.start, end: first.end });
      }
      continue;
    }
    if (dateRanges.some(([start, end]) => first.start >= start && first.start < end)) continue;
    let endIndex = i;
    while (endIndex + 1 < tokens.length) {
      const next = tokens[endIndex + 1];
      const gap = text.slice(tokens[endIndex].end, next.start);
      if (/[,;!?\n]/.test(gap)) break;
      if (isNumber(next.word) || decimalWords.has(next.word)) {
        // "30 минг к ужину": a short alias after a scale/half is a preposition, not part of the amount.
        const previousWord = tokens[endIndex].word;
        if (SHORT_ALIASES.has(next.word) && !(numeric.test(previousWord) || numbers.has(previousWord))) break;
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
    const evaluated = conflicting ? NOT_AMOUNT : evaluate(words);
    const amount = evaluated.value;
    const explicit =
      words.some((word) => scales.has(word) || word.startsWith('пол')) ||
      !!(prefixCurrency || suffixCurrency);
    const ambiguous =
      amount !== null && (evaluated.ambiguous || (currency === 'UZS' && amount < 1_000 && !explicit));
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
