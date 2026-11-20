import { describe, expect, it } from 'vitest';
import { evaluateNumberInput, formatNumber } from '../src/core/number-input';

describe('number input expressions', () => {
  it('evaluates arithmetic operators with normal precedence', () => {
    expect(evaluateNumberInput('2 + 3', 9)).toBe(5);
    expect(evaluateNumberInput('9 - 4', 9)).toBe(5);
    expect(evaluateNumberInput('3 * 4', 9)).toBe(12);
    expect(evaluateNumberInput('12 / 3', 9)).toBe(4);
    expect(evaluateNumberInput('2 + 3 * 4', 9)).toBe(14);
  });

  it('supports parentheses, whitespace, unary minus, and relative operators', () => {
    expect(evaluateNumberInput('(2 + 3) * 4', 9)).toBe(20);
    expect(evaluateNumberInput(' - (2 + 3) ', 9)).toBe(-5);
    expect(evaluateNumberInput('-2.5', 9)).toBe(-2.5);
    expect(evaluateNumberInput('+10', 5)).toBe(15);
    expect(evaluateNumberInput('*2', 5)).toBe(10);
    expect(evaluateNumberInput('/4', 20)).toBe(5);
  });

  it('rejects empty, malformed, non-finite, and zero-division input', () => {
    for (const text of ['', '   ', '1 +', '2 ** 3', '(2 + 3', '1 / 0', '1e3', 'abc'])
      expect(evaluateNumberInput(text, 4)).toBeNull();
    expect(evaluateNumberInput(`${'1' + '0'.repeat(308)} * 10`, 4)).toBeNull();
  });

  it('rounds and strips trailing zeros without returning negative zero', () => {
    expect(formatNumber(1.23456, 3)).toBe('1.235');
    expect(formatNumber(2.5, 3)).toBe('2.5');
    expect(formatNumber(12, 2)).toBe('12');
    expect(formatNumber(-0.0001, 2)).toBe('0');
    expect(formatNumber(-0, 3)).toBe('0');
  });
});
