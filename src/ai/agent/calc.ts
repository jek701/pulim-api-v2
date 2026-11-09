/** Bounded tokenizer and recursive descent. No JS evaluation or property access. */
export function calculate(expression: string): { result: number } | { error: string } {
  try {
    if (!expression.length || expression.length > 300)
      throw new Error('Expression must be 1–300 characters');
    const tokens = expression.match(/\d+(?:\.\d+)?|\.\d+|[a-zA-Z_]+|[^\s]/g) ?? [];
    let pos = 0;
    const peek = () => tokens[pos];
    const take = () => tokens[pos++];
    const expect = (s: string) => {
      if (take() !== s) throw new Error(`Expected ${s}`);
    };
    const checked = (n: number): number => {
      if (!Number.isFinite(n)) throw new Error('NaN/Infinity is not allowed');
      return n;
    };
    function primary(): number {
      if (peek() === '(') {
        take();
        const n = add();
        expect(')');
        return n;
      }
      const token = take();
      if (token && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token)) return checked(Number(token));
      if (!['round', 'min', 'max', 'abs'].includes(token))
        throw new Error('Unknown identifier or invalid token');
      expect('(');
      const args = [add()];
      while (peek() === ',') {
        take();
        args.push(add());
      }
      expect(')');
      if (token === 'min') return Math.min(...args);
      if (token === 'max') return Math.max(...args);
      if (token === 'abs' && args.length === 1) return Math.abs(args[0]);
      if (token === 'round' && args.length <= 2) {
        const digits = args[1] ?? 0;
        if (!Number.isInteger(digits) || Math.abs(digits) > 100)
          throw new Error('Invalid round digits');
        return checked(Math.round(args[0] * 10 ** digits) / 10 ** digits);
      }
      throw new Error('Invalid function arguments');
    }
    function power(): number {
      const a = primary();
      return peek() === '^' ? (take(), checked(a ** unary())) : a;
    }
    function unary(): number {
      return peek() === '-' ? (take(), -unary()) : power();
    }
    function multiply(): number {
      let a = unary();
      while (['*', '/', '%'].includes(peek())) {
        const op = take(),
          b = unary();
        if ((op === '/' || op === '%') && b === 0) throw new Error('Division by zero');
        a = checked(op === '*' ? a * b : op === '/' ? a / b : a % b);
      }
      return a;
    }
    function add(): number {
      let a = multiply();
      while (peek() === '+' || peek() === '-') {
        const op = take(),
          b = multiply();
        a = checked(op === '+' ? a + b : a - b);
      }
      return a;
    }
    const result = checked(add());
    if (pos !== tokens.length) throw new Error('Unexpected token');
    return { result };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
