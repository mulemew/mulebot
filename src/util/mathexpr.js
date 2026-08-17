'use strict';

/**
 * A small arithmetic expression evaluator.
 *
 * The obvious implementation of a /math command is eval() or new Function().
 * Both hand an attacker arbitrary code execution inside the bot process from a
 * public chat command, so neither is acceptable. This is a hand-written
 * tokeniser plus recursive-descent parser: it understands numbers, the usual
 * operators, parentheses, a fixed function table and two constants, and it
 * cannot express anything else.
 *
 * Grammar (lowest to highest precedence):
 *
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/' | '%') unary)*
 *   unary      := ('-' | '+') unary | power
 *   power      := postfix ('^' unary)?         right associative
 *   postfix    := primary '!'*
 *   primary    := number | constant | function '(' args ')' | '(' expression ')'
 *
 * Note the ordering of unary and power: exponentiation binds *tighter* than a
 * leading minus, so -3^2 is -(3^2) = -9, matching normal mathematical notation
 * rather than (-3)^2 = 9. Putting unary above power also makes 2^-1 parse,
 * since the exponent is itself a unary expression.
 */

const CONSTANTS = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  phi: (1 + Math.sqrt(5)) / 2,
  inf: Infinity,
};

/** Every callable name, with its arity. Nothing outside this table is reachable. */
const FUNCTIONS = {
  abs: { arity: 1, fn: Math.abs },
  sqrt: { arity: 1, fn: Math.sqrt },
  cbrt: { arity: 1, fn: Math.cbrt },
  ln: { arity: 1, fn: Math.log },
  log: { arity: 1, fn: Math.log10 },
  log2: { arity: 1, fn: Math.log2 },
  exp: { arity: 1, fn: Math.exp },
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  asin: { arity: 1, fn: Math.asin },
  acos: { arity: 1, fn: Math.acos },
  atan: { arity: 1, fn: Math.atan },
  sinh: { arity: 1, fn: Math.sinh },
  cosh: { arity: 1, fn: Math.cosh },
  tanh: { arity: 1, fn: Math.tanh },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  round: { arity: 1, fn: Math.round },
  trunc: { arity: 1, fn: Math.trunc },
  sign: { arity: 1, fn: Math.sign },
  deg: { arity: 1, fn: (x) => (x * 180) / Math.PI },
  rad: { arity: 1, fn: (x) => (x * Math.PI) / 180 },
  atan2: { arity: 2, fn: Math.atan2 },
  min: { arity: -1, fn: (...a) => Math.min(...a) },
  max: { arity: -1, fn: (...a) => Math.max(...a) },
  hypot: { arity: -1, fn: (...a) => Math.hypot(...a) },
  gcd: {
    arity: 2,
    fn: (a, b) => {
      let x = Math.abs(Math.trunc(a));
      let y = Math.abs(Math.trunc(b));
      while (y) [x, y] = [y, x % y];
      return x;
    },
  },
  lcm: {
    arity: 2,
    fn: (a, b) => {
      const g = FUNCTIONS.gcd.fn(a, b);
      return g === 0 ? 0 : Math.abs(Math.trunc(a) * Math.trunc(b)) / g;
    },
  },
};

class MathError extends Error {}

/** Splits the source into tokens. Throws MathError on an unexpected character. */
function tokenize(src) {
  const tokens = [];
  let i = 0;
  const s = String(src);

  while (i < s.length) {
    const c = s[i];

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // Numbers: 12, 1.5, .5, 1e-3, and 1_000 for readability.
    if (/[0-9.]/.test(c)) {
      const match = /^[0-9_]*\.?[0-9_]*(?:[eE][+-]?[0-9]+)?/.exec(s.slice(i));
      const raw = match[0].replace(/_/g, '');
      if (!raw || raw === '.') throw new MathError(`unexpected "${c}" at position ${i + 1}`);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new MathError(`"${raw}" is not a finite number`);
      tokens.push({ type: 'number', value });
      i += match[0].length;
      continue;
    }

    // Identifiers: constants and function names.
    if (/[a-zA-Z]/.test(c)) {
      const match = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(s.slice(i));
      tokens.push({ type: 'ident', value: match[0].toLowerCase() });
      i += match[0].length;
      continue;
    }

    if ('+-*/%^()!,'.includes(c)) {
      // "**" is accepted as an alias for "^" because people type it out of habit.
      if (c === '*' && s[i + 1] === '*') {
        tokens.push({ type: 'op', value: '^' });
        i += 2;
        continue;
      }
      tokens.push({ type: c === '(' || c === ')' ? c : c === ',' ? ',' : 'op', value: c });
      i++;
      continue;
    }

    throw new MathError(`unexpected character "${c}" at position ${i + 1}`);
  }

  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
    this.steps = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    // A step budget bounds the work any single expression can cost, so a
    // pathological input cannot occupy the event loop.
    if (++this.steps > 10_000) throw new MathError('expression is too complex');
    return this.tokens[this.pos++];
  }

  expect(type, value = null) {
    const tok = this.next();
    if (!tok || tok.type !== type || (value !== null && tok.value !== value)) {
      throw new MathError(`expected ${value || type}${tok ? `, found "${tok.value}"` : ' but the expression ended'}`);
    }
    return tok;
  }

  parse() {
    const value = this.expression();
    if (this.pos < this.tokens.length) {
      throw new MathError(`unexpected "${this.peek().value}" after a complete expression`);
    }
    return value;
  }

  expression() {
    let left = this.term();
    while (this.peek()?.type === 'op' && ['+', '-'].includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  term() {
    let left = this.unary();
    while (this.peek()?.type === 'op' && ['*', '/', '%'].includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.unary();
      if ((op === '/' || op === '%') && right === 0) throw new MathError('division by zero');
      if (op === '*') left *= right;
      else if (op === '/') left /= right;
      else left %= right;
    }
    return left;
  }

  unary() {
    const tok = this.peek();
    if (tok?.type === 'op' && (tok.value === '-' || tok.value === '+')) {
      this.next();
      // The operand is a full unary expression, so --3 and -2^2 both parse, the
      // latter as -(2^2) because power() sits below this level.
      const value = this.unary();
      return tok.value === '-' ? -value : value;
    }
    return this.power();
  }

  power() {
    const base = this.postfix();
    if (this.peek()?.type === 'op' && this.peek().value === '^') {
      this.next();
      // Right associative, and the exponent is a unary expression so 2^-1 works.
      const exponent = this.unary();
      const result = base ** exponent;
      if (!Number.isFinite(result)) throw new MathError('the result overflowed');
      return result;
    }
    return base;
  }

  postfix() {
    let value = this.primary();
    while (this.peek()?.type === 'op' && this.peek().value === '!') {
      this.next();
      value = factorial(value);
    }
    return value;
  }

  primary() {
    const tok = this.next();
    if (!tok) throw new MathError('the expression ended unexpectedly');

    if (tok.type === 'number') return tok.value;

    if (tok.type === '(') {
      const value = this.expression();
      this.expect(')');
      return value;
    }

    if (tok.type === 'ident') {
      if (tok.value in CONSTANTS) return CONSTANTS[tok.value];

      const fn = FUNCTIONS[tok.value];
      if (!fn) throw new MathError(`unknown name "${tok.value}"`);
      this.expect('(');
      const args = [];
      if (this.peek()?.type !== ')') {
        args.push(this.expression());
        while (this.peek()?.type === ',') {
          this.next();
          args.push(this.expression());
        }
      }
      this.expect(')');
      if (fn.arity >= 0 && args.length !== fn.arity) {
        throw new MathError(`${tok.value}() takes ${fn.arity} argument(s), got ${args.length}`);
      }
      if (fn.arity < 0 && args.length === 0) throw new MathError(`${tok.value}() needs at least one argument`);
      return fn.fn(...args);
    }

    throw new MathError(`unexpected "${tok.value}"`);
  }
}

/** Factorial with a hard ceiling; 171! already overflows a double. */
function factorial(n) {
  if (n < 0 || !Number.isInteger(n)) throw new MathError('factorial needs a non-negative whole number');
  if (n > 170) throw new MathError('factorial is limited to 170');
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}

/**
 * Evaluates an expression.
 * @param {string} source
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
function evaluate(source) {
  try {
    const src = String(source ?? '').trim();
    if (!src) return { ok: false, error: 'nothing to calculate' };
    if (src.length > 500) return { ok: false, error: 'expression is too long (500 characters max)' };

    const value = new Parser(tokenize(src)).parse();
    if (Number.isNaN(value)) return { ok: false, error: 'the result is not a number' };
    return { ok: true, value };
  } catch (e) {
    if (e instanceof MathError) return { ok: false, error: e.message };
    return { ok: false, error: 'could not parse that expression' };
  }
}

/** Formats a result so 0.30000000000000004 does not reach the user. */
function format(value) {
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return value.toLocaleString('en-US');
  const rounded = Number(value.toPrecision(12));
  if (Math.abs(rounded) >= 1e15 || (Math.abs(rounded) < 1e-6 && rounded !== 0)) return rounded.toExponential(6);
  return String(rounded);
}

module.exports = { evaluate, format, FUNCTIONS, CONSTANTS, MathError, tokenize };
