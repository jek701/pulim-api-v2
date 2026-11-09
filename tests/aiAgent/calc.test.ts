import { describe, expect, it } from 'vitest';
import { calculate } from '../../src/ai/agent/calc';
describe('safe calculator', () => {
  it.each([
    ['2+3*4', 14],
    ['(2+3)*4', 20],
    ['-2^2', -4],
    ['2^-2', 0.25],
    ['2^3^2', 512],
    ['-(-3)', 3],
    ['10%3', 1],
    ['round(1.235,2)', 1.24],
    ['min(5,abs(-2),8)', 2],
    ['max(1,2,3)', 3],
    ['round(1250,-2)', 1300],
  ])('%s = %s', (expression, result) => expect(calculate(expression)).toEqual({ result }));
  it.each([
    '1/0',
    '3%0',
    'constructor(1)',
    'process.exit()',
    'unknown',
    'Math.max(1,2)',
    'abs(1,2)',
    'round(1,1.5)',
    '1e9',
    '9^999',
    'min()',
    '1 2',
    '1+'.repeat(151),
  ])('rejects %s', (expression) => expect(calculate(expression)).toHaveProperty('error'));
});
