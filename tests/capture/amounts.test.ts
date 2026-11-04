import { describe, expect, it } from 'vitest';
import { parseAmount, parseAmounts } from '../../src/capture/amounts';
import phrases from './eval/phrases.json';

describe('capture deterministic amounts', () => {
  it.each([
    ['25 тысяч', 25_000, 'UZS'],
    ['25 минг', 25_000, 'UZS'],
    ['25k', 25_000, 'UZS'],
    ['25 000', 25_000, 'UZS'],
    ['25.000', 25_000, 'UZS'],
    ['25,000', 25_000, 'UZS'],
    ['1,2 млн', 1_200_000, 'UZS'],
    ['полтора миллиона', 1_500_000, 'UZS'],
    ['yigirma besh ming', 25_000, 'UZS'],
    ['икки юз минг', 200_000, 'UZS'],
    ['bir yarim million', 1_500_000, 'UZS'],
    ['100 баксов', 100, 'USD'],
    ['$20', 20, 'USD'],
    ['1 234,56 EUR', 1234.56, 'EUR'],
    ['1.234,56 EUR', 1234.56, 'EUR'],
    ['1,234.56 USD', 1234.56, 'USD'],
    ['25\u202f000 сўм', 25_000, 'UZS'],
    ['25\u00a0000 soʻm', 25_000, 'UZS'],
    ['+25k', 25_000, 'UZS'],
    ['twenty-five thousand', 25_000, 'UZS'],
    ['two and a half million', 2_500_000, 'UZS'],
    ['half a million', 500_000, 'UZS'],
    ['yarim million', 500_000, 'UZS'],
    ['полмиллиона', 500_000, 'UZS'],
    ['полтысячи', 500, 'UZS'],
    ['два с половиной миллиона', 2_500_000, 'UZS'],
    ['one million two hundred thirty four thousand five hundred sixty seven', 1_234_567, 'UZS'],
    ['бир миллион икки юз ўттиз тўрт минг беш юз олтмиш етти', 1_234_567, 'UZS'],
    ['миллион двести пятьдесят тысяч', 1_250_000, 'UZS'],
    ['one point two million', 1_200_000, 'UZS'],
    ['bir butun ikki million', 1_200_000, 'UZS'],
    ['один запятая пять миллиона', 1_500_000, 'UZS'],
    ['2 mlrd', 2_000_000_000, 'UZS'],
    ['25.50 USD', 25.5, 'USD'],
    ['₽500', 500, 'RUB'],
    ['£12.99', 12.99, 'GBP'],
    ['100 AED', 100, 'AED'],
    ['1500 KZT', 1500, 'KZT'],
    ['50 CNY', 50, 'CNY'],
    ['200 TRY', 200, 'TRY'],
    ['¥100', 100, 'JPY'],
    ['20 евро', 20, 'EUR'],
    ['ЎН БЕШ МИНГ СЎМ', 15_000, 'UZS'],
    ['o’ttiz to‘rt ming soʼm', 34_000, 'UZS'],
    ['o`n toʻqqiz ming', 19_000, 'UZS'],
    ['сто восемьдесят девять тысяч', 189_000, 'UZS'],
    ['two hundred and five thousand', 205_000, 'UZS'],
    ['25тыс. сум', 25_000, 'UZS'],
    ['99.99 dollars', 99.99, 'USD'],
    ['one thousand and five som', 1005, 'UZS'],
    ['0.125k', 125, 'UZS'],
    ['0.25 million', 250_000, 'UZS'],
    ['zero point five dollars', 0.5, 'USD'],
  ] as const)('parses %s without model arithmetic', (text, amount, currency) => {
    expect(parseAmount(text)).toMatchObject({ amount, currency, confidence: 'high' });
  });

  it.each(['45', 'сорок пять', 'qirq besh', 'қирқ беш', 'forty five'])(
    'flags omitted UZS scale in %s',
    (text) => {
      expect(parseAmount(text)).toEqual({
        amount: 45,
        currency: 'UZS',
        confidence: 'low',
        reason: 'ambiguous',
      });
    },
  );

  it.each([
    '0',
    '-5',
    '−5',
    'minus five dollars',
    'минус пять тысяч',
    'manfiy besh ming',
    '1e20',
    '9000000000000000',
    'twenty thirty thousand',
    'five five dollars',
    '1,23,456',
    '1.2.3',
    'one million million',
    '$20 EUR',
    '0.001 USD',
    '12.3456 USD',
    'one point two five five dollars',
    'zero thousand',
    'ноль миллионов',
    'nol yuz ming',
  ])('does not invent a valid amount from %s', (text) => {
    expect(parseAmount(text).amount).toBeNull();
    expect(parseAmount(text).confidence).toBe('low');
  });

  it.each(['', 'hello', 'not a transaction', 'завтра обед', 'qahva yaxshi', '2026-11-04', '14:30'])(
    'has no amount in %s',
    (text) => {
      expect(parseAmount(text)).toMatchObject({
        amount: null,
        confidence: 'low',
        reason: 'missing',
      });
    },
  );

  it('does not select one amount from multiple operations', () => {
    expect(parseAmount('такси 30 минг и обед 45')).toMatchObject({
      amount: null,
      reason: 'ambiguous',
    });
    expect(
      parseAmounts('такси 30 минг и обед 45').map(({ amount, confidence }) => ({
        amount,
        confidence,
      })),
    ).toEqual([
      { amount: 30_000, confidence: 'high' },
      { amount: 45, confidence: 'low' },
    ]);
  });

  it('preserves source offsets and operation-local currencies', () => {
    const text = 'coffee $20 and такси 30 минг; книга 15 EUR';
    const amounts = parseAmounts(text);
    expect(amounts.map(({ amount, currency }) => ({ amount, currency }))).toEqual([
      { amount: 20, currency: 'USD' },
      { amount: 30_000, currency: 'UZS' },
      { amount: 15, currency: 'EUR' },
    ]);
    for (const amount of amounts) expect(text.slice(amount.start, amount.end)).toBe(amount.text);
  });

  it('ignores a date and time around an amount', () => {
    expect(parseAmount('2026-11-04 в 14:30 такси 30 тысяч')).toMatchObject({ amount: 30_000 });
  });
});

describe('review regressions: never a confident wrong number', () => {
  it.each([
    ['миллион с половиной', 1_500_000], ['тысяча с половиной', 1_500], ['две тысячи с половиной', 2_500],
    ['ming yarim', 1_500], ['million yarim', 1_500_000], ['bir million yarim', 1_500_000],
    ['миллион ярим', 1_500_000], ['a million and a half', 1_500_000],
    // The half BEFORE the scale keeps its old meaning.
    ['bir yarim million', 1_500_000], ['yarim million', 500_000], ['half a million', 500_000],
    ['пол миллиона', 500_000], ['пол тысячи', 500], ['пол-миллиона', 500_000], ['пол-тысячи', 500],
    ['полтора миллиона', 1_500_000], ['полторы тысячи', 1_500],
  ])('reads the half in %s as %i', (text, amount) => {
    expect(parseAmount(text)).toMatchObject({ amount, confidence: 'high' });
  });

  it.each([
    'сто тысяч с половиной', 'двадцать тысяч с половиной', '1,2 млн с половиной', 'пол 5', 'ming yarim yarim',
  ])('does not guess the half in %s', (text) => {
    expect(parseAmount(text).amount).toBeNull();
  });

  it.each(['к ужину', 'потратил к', 'м', 'b', 'тысяч', 'тысячи', 'миллиона', 'млн', 'тыс'])(
    'does not treat the bare scale word in "%s" as an amount', (text) => {
      const result = parseAmount(text);
      expect(result.amount === null || result.confidence === 'low').toBe(true);
      expect(result.amount).not.toBe(1_000);
      expect(result.amount).not.toBe(1_000_000);
    });

  it('keeps a short alias out of an amount that ends before it', () => {
    expect(parseAmounts('30 минг к ужину').map((a) => [a.amount, a.text])).toEqual([[30_000, '30 минг']]);
    expect(parseAmounts('5 тысяч к ужину').map((a) => a.amount)).toEqual([5_000]);
    expect(parseAmount('25 к')).toMatchObject({ amount: 25_000, confidence: 'high' });
    expect(parseAmount('25k')).toMatchObject({ amount: 25_000, confidence: 'high' });
  });

  it('flags a lone stand-alone scale word as low confidence', () => {
    for (const text of ['тысяча', 'миллион', 'ming', 'thousand']) {
      expect(parseAmount(text)).toMatchObject({ confidence: 'low' });
    }
  });

  it.each(['10-15 тысяч', '50-60 минг', '10 - 15 тысяч', '10–15 тыс', '2-3 млн', '100-200 k'])(
    'never reads the range %s as one confident amount', (text) => {
      const result = parseAmount(text);
      expect(result.amount).toBeNull();
      expect(result.confidence).toBe('low');
    });

  it.each([
    ['тысячу двести', 1_200], ['одну тысячу', 1_000], ['двух тысяч', 2_000], ['трёх тысяч', 3_000],
    ['трех тысяч', 3_000], ['четырёх тысяч', 4_000], ['пяти тысяч', 5_000], ['шести тысяч', 6_000],
    ['двадцати пяти тысяч', 25_000], ['ста тысяч', 100_000], ['двухсот тысяч', 200_000],
    ['пятисот тысяч', 500_000], ['двух миллионов', 2_000_000], ['пяти миллионов', 5_000_000],
    ['двумя тысячами', 2_000], ['тысячи двести', null],
  ])('reads the case forms in "%s"', (text, amount) => {
    expect(parseAmount(text).amount).toBe(amount);
  });

  it('returns null when an unknown word sits inside a number phrase', () => {
    for (const text of ['двадцать пять абв тысяч', 'сто двадцать несколько тысяч', 'two zorp thousand']) {
      expect(parseAmount(text).amount).toBeNull();
    }
  });

  it.each(['1.250 млн', '1,250 million', '2.500 млн', '1.250 млрд', '3,500 k'])(
    'reads "%s" as a decimal, but only as a guess', (text) => {
      const result = parseAmount(text);
      expect(result.confidence).toBe('low');
      expect(result.reason).toBe('ambiguous');
    });
  it('uses the decimal meaning of a lone group before a scale word', () => {
    expect(parseAmount('1.250 млн').amount).toBe(1_250_000);
    expect(parseAmount('1,250 million').amount).toBe(1_250_000);
    expect(parseAmount('2.500 млн').amount).toBe(2_500_000);
    // Without a scale word the group is still thousands, with full confidence.
    expect(parseAmount('1.250')).toMatchObject({ amount: 1_250, currency: 'UZS' });
    expect(parseAmount('25.000 сум')).toMatchObject({ amount: 25_000, confidence: 'high' });
  });
});

describe('synthetic capture evaluation corpus', () => {
  it('covers every supported speech language and multi-operation phrases', () => {
    expect(phrases.length).toBeGreaterThanOrEqual(120);
    expect(new Set(phrases.map((phrase) => phrase.language))).toEqual(
      new Set(['ru', 'uz-Latn', 'uz-Cyrl', 'en', 'mixed']),
    );
    expect(phrases.filter((phrase) => phrase.operationCount > 1).length).toBeGreaterThanOrEqual(20);
    expect(new Set(phrases.map((phrase) => phrase.id)).size).toBe(phrases.length);
    for (const phrase of phrases) {
      expect(phrase.operations).toHaveLength(phrase.operationCount);
      for (const operation of phrase.operations)
        expect(phrase.text).toContain(operation.amountSpan);
    }
  });

  it('scores at least 98% on the whole phrases and their source spans, without any model', () => {
    let count = 0;
    let correct = 0;
    const failures: string[] = [];
    for (const phrase of phrases) {
      const amounts = parseAmounts(phrase.text);
      const wholePhrase =
        amounts.length === phrase.operationCount &&
        phrase.operations.every(
          (operation, i) =>
            amounts[i].amount === operation.amount && amounts[i].currency === operation.currency,
        );
      count++;
      if (wholePhrase) correct++;
      else failures.push(phrase.id);
      phrase.operations.forEach((operation) => {
        const amount = parseAmount(operation.amountSpan);
        expect(amount, `${phrase.id}: ${operation.amountSpan}`).toMatchObject({
          amount: operation.amount,
          currency: operation.currency,
        });
        if ((operation as { lowConfidence?: boolean }).lowConfidence) {
          expect(amount.confidence, `${phrase.id}: must be flagged`).toBe('low');
        }
      });
    }
    expect({ accuracy: correct / count, failures }).toEqual({ accuracy: 1, failures: [] });
    expect(correct / count).toBeGreaterThanOrEqual(0.98);
  });
});
