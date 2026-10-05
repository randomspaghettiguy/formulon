// Hand-written tokenizer and Pratt parser for Salesforce formulas.
//
// Replaces the generated Peggy grammar: that grammar backtracked, so parse time doubled with
// every nesting level (20 nested IFs took 8 seconds), and it got several precedence rules wrong.
// This parser reads each character once and builds the same AST shapes the evaluator expects:
//   { type: 'literal', value, dataType, options }
//   { type: 'identifier', name }
//   { type: 'callExpression', id, arguments }

import FormulonSyntaxError from './errors/SyntaxError.js';

// Binding powers, lowest first. Operators with equal power associate to the left, except `^`.
const BINARY = {
  '||': { bp: 1, id: 'or' },
  '&&': { bp: 2, id: 'and' },
  '=': { bp: 3, id: 'equal' },
  '==': { bp: 3, id: 'equal' },
  '!=': { bp: 3, id: 'unequal' },
  '<>': { bp: 3, id: 'unequal' },
  '<': { bp: 3, id: 'lessThan' },
  '<=': { bp: 3, id: 'lessThanOrEqual' },
  '>': { bp: 3, id: 'greaterThan' },
  '>=': { bp: 3, id: 'greaterThanOrEqual' },
  '+': { bp: 4, id: 'add' },
  '-': { bp: 4, id: 'subtract' },
  '&': { bp: 4, id: 'concat' },
  '*': { bp: 5, id: 'multiply' },
  '/': { bp: 5, id: 'divide' },
  // ^ binds tighter than * and /, left to right (2^3^2 is 64). Unary minus binds tighter still:
  // -2^2 is 4. Salesforce's samples rely on this (PI() * Radius__c ^ 2, compound interest).
  // Known Issue W-7622870 reports 2*2^3 giving 64 in some orgs; see the needs-org cases.
  '^': { bp: 6, id: 'exponentiate' },
};
const PREFIX_BP = 7;

// Longest first, so `<=` wins over `<`.
const PUNCTUATION = ['&&', '||', '==', '!=', '<>', '<=', '>=', '+', '-', '*', '/', '^', '&', '=', '<', '>', '!', '(', ')', ',', '[', ']'];

const ESCAPES = {
  n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', "'": "'", '\\': '\\',
};

const WHITESPACE = /[\s\u00A0\u200B\uFEFF]/;
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$.]/;
const DIGIT = /[0-9]/;
const FUNCTION_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const MAX_DEPTH = 2000;

const fail = (message, offset) => {
  throw new FormulonSyntaxError(`Syntax error. ${message}`, { offset });
};

const tokenize = (src) => {
  const tokens = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (WHITESPACE.test(ch)) {
      i += 1;
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) fail('Comment is not closed.', i);
      i = end + 2;
    } else if (ch === '{' && src[i + 1] === '!') {
      // Flow and email-template merge field: {!$Record.Amount} is the reference $Record.Amount.
      const close = src.indexOf('}', i);
      const name = close === -1 ? '' : src.slice(i + 2, close).trim();
      if (!/^\$?[A-Za-z_][A-Za-z0-9_]*(?:\.\$?[A-Za-z_][A-Za-z0-9_]*)*$/.test(name)) fail('Invalid merge field {!...}.', i);
      tokens.push({
        kind: 'name', value: name, merge: true, offset: i,
      });
      i = close + 1;
    } else if (ch === '"' || ch === "'") {
      const start = i;
      let value = '';
      i += 1;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') {
          const escaped = ESCAPES[src[i + 1]];
          if (escaped === undefined) fail(`Invalid escape sequence '\\${src[i + 1] ?? ''}'.`, i);
          value += escaped;
          i += 2;
        } else {
          value += src[i];
          i += 1;
        }
      }
      if (i >= src.length) fail('Text is not closed with a quote.', start);
      i += 1;
      tokens.push({ kind: 'string', value, offset: start });
    } else if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(src[i + 1] ?? ''))) {
      const start = i;
      while (DIGIT.test(src[i] ?? '')) i += 1;
      if (src[i] === '.' && DIGIT.test(src[i + 1] ?? '')) {
        i += 1;
        while (DIGIT.test(src[i] ?? '')) i += 1;
      } else if (src[i] === '.' && !IDENT_START.test(src[i + 1] ?? '')) {
        i += 1; // `1.` is a valid number
      }
      if (IDENT_START.test(src[i] ?? '')) fail(`Unexpected '${src[i]}' after a number.`, i);
      tokens.push({ kind: 'number', text: src.slice(start, i), offset: start });
    } else if (IDENT_START.test(ch) || (ch === '[' && /^\[[A-Za-z_][A-Za-z0-9_]*\]\./.test(src.slice(i, i + 80)))) {
      const start = i;
      // Process Builder style reference: [Contact].Account.Name
      if (ch === '[') i = src.indexOf(']', i) + 1;
      // Report summary fields are written AMOUNT:SUM.
      while (i < src.length && (IDENT_PART.test(src[i]) || (src[i] === ':' && /[A-Za-z]/.test(src[i + 1] ?? '')))) i += 1;
      tokens.push({ kind: 'name', value: src.slice(start, i), offset: start });
    } else {
      const op = PUNCTUATION.find((p) => src.startsWith(p, i));
      if (!op) fail(`Unexpected character '${ch}'.`, i);
      tokens.push({ kind: 'op', value: op, offset: i });
      i += op.length;
    }
  }

  tokens.push({ kind: 'end', offset: src.length });
  return tokens;
};

const numberLiteral = (text, negative) => {
  const [intPart, fracPart = ''] = text.split('.');
  const digits = intPart.replace(/^0+(?=\d)/, '');
  const value = Number(text) * (negative ? -1 : 1);
  const options = { length: digits.length || 1, scale: fracPart.length };
  // Doubles hold ~15 significant digits; keep the written form so TEXT() of a long literal is exact.
  if ((digits + fracPart).replace(/^0+/, '').length > 15) options.source = (negative ? '-' : '') + text;
  return {
    type: 'literal',
    value: Object.is(value, -0) ? 0 : value,
    dataType: 'number',
    options,
  };
};

const stringLiteral = (value) => ({
  type: 'literal', value, dataType: 'text', options: { length: value.length },
});

const KEYWORDS = {
  true: { type: 'literal', value: true, dataType: 'checkbox', options: {} },
  false: { type: 'literal', value: false, dataType: 'checkbox', options: {} },
  null: { type: 'literal', value: null, dataType: 'null', options: {} },
};

const call = (id, args) => ({ type: 'callExpression', id, arguments: args });

export const parseFormula = (src) => {
  const tokens = tokenize(src);
  let pos = 0;
  let depth = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];  
  const isOp = (value) => peek().kind === 'op' && peek().value === value;
  const expect = (value) => {
    if (!isOp(value)) fail(`Expected '${value}'.`, peek().offset);
    return next();
  };

  const parseArguments = () => {
    const args = [];
    expect('(');
    if (isOp(')')) {
      next();
      return args;
    }
    for (;;) {
      if (isOp(',') || isOp(')')) fail('Missing argument.', peek().offset);
      args.push(expression(0));
      if (isOp(',')) {
        next();
      } else {
        expect(')');
        return args;
      }
    }
  };

  const prefix = () => {
    const token = next();

    switch (token.kind) {
      case 'number':
        return numberLiteral(token.text, false);
      case 'string':
        return stringLiteral(token.value);
      case 'name': {
        if (token.merge) return { type: 'identifier', name: token.value };
        if (isOp('(')) {
          if (!FUNCTION_NAME.test(token.value)) fail(`'${token.value}' is not a function name.`, token.offset);
          return call(token.value.toLowerCase(), parseArguments());
        }
        const keyword = KEYWORDS[token.value.toLowerCase()];
        if (keyword) return { ...keyword, options: { ...keyword.options } };
        if (token.value.endsWith('.')) fail(`Field name '${token.value}' ends with a dot.`, token.offset);
        return { type: 'identifier', name: token.value };
      }
      case 'op':
        if (token.value === '(') {
          const inner = expression(0);
          expect(')');
          return inner;
        }
        if (token.value === '-') {
          if (peek().kind === 'number' && !(tokens[pos + 1].kind === 'op' && tokens[pos + 1].value === '^')) {
            return numberLiteral(next().text, true);
          }
          return call('negate', [expression(PREFIX_BP)]);
        }
        if (token.value === '+') {
          if (peek().kind === 'number' && !(tokens[pos + 1].kind === 'op' && tokens[pos + 1].value === '^')) {
            return numberLiteral(next().text, false);
          }
          return call('identity', [expression(PREFIX_BP)]);
        }
        if (token.value === '!') return call('not', [expression(PREFIX_BP)]);
        if (token.value === '[') {
          // URLFOR/INCLUDE/LINKTO parameter list: [name = value, ...]
          const values = [];
          while (!isOp(']')) {
            if (peek().kind !== 'name') fail('Expected a parameter name.', peek().offset);
            next();
            expect('=');
            values.push(expression(0));
            if (!isOp(']')) expect(',');
          }
          next();
          return call('$params', values);
        }
        return fail(`Unexpected '${token.value}'.`, token.offset);
      default:
        return fail('Unexpected end of formula.', token.offset);
    }
  };

  // Hoisted: parseArguments and prefix call it before this point.
  function expression(minBp) {
    depth += 1;
    if (depth > MAX_DEPTH) fail('Formula is nested too deeply.', peek().offset);

    let left = prefix();

    for (;;) {
      const token = peek();
      const op = token.kind === 'op' && BINARY[token.value];
      if (!op || op.bp <= minBp) break;
      next();
      const right = expression(op.right ? op.bp - 1 : op.bp);
      left = call(op.id, [left, right]);
    }

    depth -= 1;
    return left;
  }

  const ast = expression(0);
  if (peek().kind !== 'end') fail(`Unexpected '${peek().value ?? peek().text}'.`, peek().offset);
  return ast;
};

export default parseFormula;
