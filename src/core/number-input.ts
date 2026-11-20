export function evaluateNumberInput(text: string, current: number): number | null {
  const input = text.trim();
  if (!input || !Number.isFinite(current)) return null;
  const source = /^[+*/]/.test(input) ? `${current}${input}` : input;
  let index = 0;

  function whitespace(): void {
    while (/\s/.test(source[index] ?? '') && index < source.length) index++;
  }
  function expression(): number {
    let value = term();
    while (true) {
      whitespace();
      const operator = source[index];
      if (operator !== '+' && operator !== '-') return value;
      index++;
      const right = term();
      value = operator === '+' ? value + right : value - right;
      if (!Number.isFinite(value)) throw new Error();
    }
  }
  function term(): number {
    let value = unary();
    while (true) {
      whitespace();
      const operator = source[index];
      if (operator !== '*' && operator !== '/') return value;
      index++;
      const right = unary();
      if (operator === '/' && right === 0) throw new Error();
      value = operator === '*' ? value * right : value / right;
      if (!Number.isFinite(value)) throw new Error();
    }
  }
  function unary(): number {
    whitespace();
    if (source[index] === '-') {
      index++;
      return -unary();
    }
    if (source[index] === '+') {
      index++;
      return unary();
    }
    return primary();
  }
  function primary(): number {
    whitespace();
    if (source[index] === '(') {
      index++;
      const value = expression();
      whitespace();
      if (source[index] !== ')') throw new Error();
      index++;
      return value;
    }
    const start = index;
    while (/[0-9.]/.test(source[index] ?? '') && index < source.length) index++;
    if (start === index) throw new Error();
    const token = source.slice(start, index);
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) throw new Error();
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error();
    return value;
  }

  try {
    const result = expression();
    whitespace();
    return index === source.length && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

export function formatNumber(value: number, precision: number): string {
  if (!Number.isFinite(value)) return String(value);
  const digits = Math.max(0, Math.min(100, Math.trunc(precision)));
  const rounded = Number(value.toFixed(digits));
  if (Object.is(rounded, -0) || rounded === 0) return '0';
  return rounded
    .toFixed(digits)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}
