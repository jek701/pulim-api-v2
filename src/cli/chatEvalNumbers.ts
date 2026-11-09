/** Locale-independent extraction: grouped thousands, decimal comma, million suffixes. */
export function extractNumbers(text: string): number[] {
  const clean = text.replace(/[\u00a0\u202f]/g, ' ').replace(/(?<=\d)[’'](?=\d{3}\b)/g, '');
  const matches = clean.matchAll(
    /[-−]?\d+(?:[ ,]\d{3})*(?:[.,]\d+)?\s*(?:млн|миллион(?:а|ов)?|million|mln|m(?![a-z])|тыс(?:яч[аи]?)?|ming|thousand|k(?![a-z]))?/gi,
  );
  return [...matches]
    .map(([token]) => {
      const scale = /млн|миллион|million|mln|m\s*$/i.test(token)
        ? 1e6
        : /тыс|ming|thousand|k\s*$/i.test(token)
          ? 1e3
          : 1;
      const value = token
        .replace('−', '-')
        .replace(/[^\d.,-]/g, '')
        .replace(/,(?=\d{3}(?:[,.]|$))/g, '')
        .replace(',', '.');
      return Number(value) * scale;
    })
    .filter(Number.isFinite);
}
export function gradeNumeric(answer: string, expected: number[], tolerance = 0.01): boolean {
  const numbers = extractNumbers(answer);
  // A decrease may be phrased as a positive magnitude instead of a signed delta.
  return expected.every((target) =>
    numbers.some(
      (n) => Math.abs(Math.abs(n) - Math.abs(target)) <= Math.max(1, Math.abs(target) * tolerance),
    ),
  );
}
