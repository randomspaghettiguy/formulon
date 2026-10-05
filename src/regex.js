// Linear-time regular expression matcher for REGEX(text, pattern).
//
// JavaScript's RegExp backtracks: REGEX(text, "(a+)+") on 30 characters runs for minutes, and a
// synchronous call in a browser cannot be interrupted. This is a Pike VM (Thompson NFA
// simulation): it advances every possible match position at once, so the work is bounded by
// text length x program size and can never blow up. REGEX only asks whether the whole text
// matches, so greedy and lazy quantifiers are equivalent and no capture positions are needed.
//
// Supported (Java syntax, as Salesforce uses): literals and escapes, `.`, classes `[a-z]`,
// `[^...]`, nested `[a[bc]]` and intersected `[a-z&&[^aeiou]]` classes, \d \D \w \W \s \S \b \B,
// \p{...} / \P{...} (POSIX names such as Alpha, and Unicode categories such as L or Lu), groups
// `(...)` `(?:...)` `(?<name>...)`, alternation, quantifiers * + ? {n} {n,} {n,m} with lazy forms,
// possessive quantifiers on a single character or class, ^ $, inline flags (?i) (?s).
//
// Lookaround and backreferences cannot be matched in linear time. Patterns using them run on
// JavaScript's RegExp only when the work is provably bounded (no nested quantifiers, and
// text length ^ quantifier count <= 10^7); otherwise REGEX reports NotSupportedError rather than
// risk a hang.

import EvaluationError from './errors/EvaluationError.js';
import NotSupportedError from './errors/NotSupportedError.js';

const MAX_PROGRAM = 2000;
const MAX_REPEAT = 1000;
const MAX_BACKTRACKING_WORK = 1e7;

// Java's POSIX character classes, \p{Name}.
const POSIX = {
  Lower: 'a-z',
  Upper: 'A-Z',
  ASCII: '\\x00-\\x7F',
  Alpha: 'A-Za-z',
  Digit: '0-9',
  Alnum: 'A-Za-z0-9',
  Punct: '!-\\/:-@\\[-`{-~',
  Graph: '!-~',
  Print: ' -~',
  Blank: ' \\t',
  Cntrl: '\\x00-\\x1F\\x7F',
  XDigit: '0-9a-fA-F',
  Space: ' \\t\\n\\x0B\\f\\r',
};
// JavaScript source for \p{name}, or null when JavaScript has no equivalent.
const propertySource = (name) => {
  if (POSIX[name]) return `[${POSIX[name]}]`;
  const unicode = name.replace(/^Is(?=[A-Z])/, '');
  try {
    new RegExp(`\\p{${unicode}}`, 'u');  
    return `\\p{${unicode}}`;
  } catch {
    return null;
  }
};

// Thrown while parsing to switch to the bounded RegExp path.
class NeedsBacktracking extends Error {}

const invalid = (pattern, why) => {
  throw new EvaluationError(`#Error! Invalid regular expression '${pattern}': ${why}.`, { function: 'regex' });
};
const unsupported = (pattern, what) => {
  throw new NotSupportedError(`REGEX() ${what} is not supported (it cannot be matched in linear time): '${pattern}'.`, { function: 'regex' });
};

const isWord = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const CLASSES = {
  d: (c) => c >= '0' && c <= '9',
  w: isWord,
  s: (c) => c === ' ' || c === '\t' || c === '\n' || c === '\x0B' || c === '\f' || c === '\r',
};
const SIMPLE_ESCAPES = {
  t: '\t', n: '\n', r: '\r', f: '\f', a: '\x07', e: '\x1B', 0: '\0',
};

// ---------------------------------------------------------------------------------------------
// Pattern parser: produces nodes
//   { t: 'char', test }  { t: 'seq', items }  { t: 'alt', options }
//   { t: 'rep', node, min, max }  { t: 'assert', kind: '^' | '$' | 'b' | 'B' }

const parsePattern = (pattern) => {
  const src = Array.from(pattern);
  let i = 0;
  const flags = { i: false, s: false };

  const peek = () => src[i];
  const eat = (c) => {
    if (src[i] === c) {
      i += 1;
      return true;
    }
    return false;
  };

  const charTest = (c) => (flags.i
    ? (x) => x === c || (x !== undefined && x.toLowerCase() === c.toLowerCase())
    : (x) => x === c);

  const readHex = (len) => {
    const hex = src.slice(i, i + len).join('');
    if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) invalid(pattern, 'bad hex escape');
    i += len;
    return String.fromCodePoint(parseInt(hex, 16));
  };

  // Returns { test } for a class-like escape or { char } for a literal one.
  const readEscape = (inClass) => {
    const c = src[i];
    if (c === undefined) invalid(pattern, 'trailing backslash');
    i += 1;
    const lower = c.toLowerCase();
    if (CLASSES[lower]) {
      const base = CLASSES[lower];
      return { test: c === lower ? base : (x) => x !== undefined && !base(x) };
    }
    if (SIMPLE_ESCAPES[c] !== undefined) return { char: SIMPLE_ESCAPES[c] };
    if (c === 'p' || c === 'P') {
      if (src[i] !== '{') invalid(pattern, '\\p needs {name}');
      const close = src.indexOf('}', i);
      if (close === -1) invalid(pattern, 'unclosed \\p{');
      const name = src.slice(i + 1, close).join('');
      i = close + 1;
      const source = propertySource(name);
      if (!source) unsupported(pattern, `character property \\p{${name}}`);
      const re = new RegExp(`^${source}$`, 'u');
      const test = (x) => x !== undefined && re.test(x);
      return { test: c === 'p' ? test : (x) => x !== undefined && !test(x) };
    }
    if (c === 'u') return { char: readHex(4) };
    if (c === 'x') return { char: readHex(2) };
    if (!inClass && (c === 'b' || c === 'B')) return { assert: c };
    if (/[1-9]/.test(c) || c === 'k') throw new NeedsBacktracking();
    if (c === 'Q' || c === 'G' || c === 'Z' || c === 'z' || c === 'A') unsupported(pattern, `escape \\${c}`);
    if (/[A-Za-z]/.test(c)) invalid(pattern, `unknown escape \\${c}`);
    return { char: c };
  };

  // Java classes: union by nesting [a[bc]], intersection with && ([a-z&&[^aeiou]]).
  const parseClass = () => {
    const negate = eat('^');
    let tests = [];
    let first = true;
    const intersections = [];
    while (peek() !== ']' || first) {
      if (peek() === undefined) invalid(pattern, 'unclosed character class');
      first = false;
      if (peek() === '&' && src[i + 1] === '&') {
        i += 2;
        const left = tests;
        intersections.push((x) => left.some((t) => t(x)));
        tests = [];
        if (peek() === ']') invalid(pattern, 'empty intersection');
        continue;  
      }
      if (peek() === '[') {
        i += 1;
        tests.push(parseClass());
        continue;  
      }
      let lo;
      if (eat('\\')) {
        const e = readEscape(true);
        if (e.test) {
          tests.push(e.test);
          continue;  
        }
        lo = e.char;
      } else {
        lo = src[i];
        i += 1;
      }
      if (peek() === '-' && src[i + 1] !== ']' && src[i + 1] !== undefined) {
        i += 1;
        let hi;
        if (eat('\\')) {
          const e = readEscape(true);
          if (e.test) invalid(pattern, 'bad range');
          hi = e.char;
        } else {
          hi = src[i];
          i += 1;
        }
        if (hi.codePointAt(0) < lo.codePointAt(0)) invalid(pattern, 'range out of order');
        const [a, b] = [lo.codePointAt(0), hi.codePointAt(0)];
        const inRange = (x) => x !== undefined && x.codePointAt(0) >= a && x.codePointAt(0) <= b;
        tests.push(flags.i ? (x) => x !== undefined && (inRange(x) || inRange(x.toLowerCase()) || inRange(x.toUpperCase())) : inRange);
      } else {
        tests.push(charTest(lo));
      }
    }
    i += 1; // ]
    const last = tests;
    const parts = [...intersections, (x) => last.some((t) => t(x))];
    return (x) => x !== undefined && parts.every((t) => t(x)) !== negate;
  };

  const parseAtom = () => {
    const c = peek();
    if (c === '(') {
      i += 1;
      if (eat('?')) {
        if (peek() === '=' || peek() === '!') throw new NeedsBacktracking();
        if (peek() === '<' && (src[i + 1] === '=' || src[i + 1] === '!')) throw new NeedsBacktracking();
        if (peek() === '>') unsupported(pattern, 'atomic group');
        if (eat('<')) {
          while (peek() !== '>') {
            if (peek() === undefined || !/[A-Za-z0-9]/.test(peek())) invalid(pattern, 'bad group name');
            i += 1;
          }
          i += 1;
        } else if (!eat(':')) {
          // Inline flags: (?i) (?s) (?is) or scoped (?i:...)
          const saved = { ...flags };
          while (/[a-zA-Z-]/.test(peek() ?? '')) {
            const f = src[i];
            i += 1;
            if (f === 'i' || f === 's') flags[f] = true;
            else if (f !== 'u' && f !== 'm' && f !== 'x' && f !== 'd') invalid(pattern, `unknown flag ${f}`);
            if (f === 'x') unsupported(pattern, 'comments mode (?x)');
          }
          if (eat(')')) return { t: 'seq', items: [] };
          if (!eat(':')) invalid(pattern, 'bad group');
          const inner = parseAlt();
          if (!eat(')')) invalid(pattern, 'unclosed group');
          Object.assign(flags, saved);
          return inner;
        }
      }
      const inner = parseAlt();
      if (!eat(')')) invalid(pattern, 'unclosed group');
      return inner;
    }
    i += 1;
    if (c === '[') return { t: 'char', test: parseClass() };
    if (c === '.') return { t: 'char', test: flags.s ? (x) => x !== undefined : (x) => x !== undefined && x !== '\n' && x !== '\r' };
    if (c === '^' || c === '$') return { t: 'assert', kind: c };
    if (c === '\\') {
      const e = readEscape(false);
      if (e.assert) return { t: 'assert', kind: e.assert };
      return { t: 'char', test: e.test || charTest(e.char) };
    }
    if (c === '*' || c === '+' || c === '?' || c === '{') invalid(pattern, `nothing to repeat before '${c}'`);
    if (c === ')') invalid(pattern, 'unmatched )');
    return { t: 'char', test: charTest(c) };
  };

  const parseQuantified = () => {
    let node = parseAtom();
    for (;;) {
      let min;
      let max;
      if (eat('*')) [min, max] = [0, Infinity];
      else if (eat('+')) [min, max] = [1, Infinity];
      else if (eat('?')) [min, max] = [0, 1];
      else if (peek() === '{' && /^\{\d+(,\d*)?\}/.test(src.slice(i, i + 12).join(''))) {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i, i + 12).join(''));
        i += m[0].length;
        min = +m[1];
        max = m[2] === undefined ? min : (m[3] === '' ? Infinity : +m[3]);
        if (max < min) invalid(pattern, 'bad repetition range');
        if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) unsupported(pattern, `repetition above ${MAX_REPEAT}`);
      } else {
        return node;
      }
      if (eat('+')) {
        // Possessive: take as many as possible and never give back. For a single character or
        // class that is the greedy loop followed by "the next character is not one of them".
        if (node.t !== 'char') unsupported(pattern, 'possessive quantifier on a group');
        node = {
          t: 'seq',
          items: [{
            t: 'rep', node, min, max,
          }, ...(max === Infinity ? [{ t: 'notahead', test: node.test }] : [])],
        };
      } else {
        eat('?'); // lazy: same result for a whole-text match
        node = {
          t: 'rep', node, min, max,
        };
      }
    }
  };

  const parseSeq = () => {
    const items = [];
    while (peek() !== undefined && peek() !== '|' && peek() !== ')') items.push(parseQuantified());
    return { t: 'seq', items };
  };

  function parseAlt() {
    const options = [parseSeq()];
    while (eat('|')) options.push(parseSeq());
    return options.length === 1 ? options[0] : { t: 'alt', options };
  }

  const tree = parseAlt();
  if (i < src.length) invalid(pattern, 'unmatched )');
  return tree;
};

// ---------------------------------------------------------------------------------------------
// Compiler to Pike VM instructions:
//   { op: 'char', test }  { op: 'split', x, y }  { op: 'jmp', x }  { op: 'assert', kind }  { op: 'match' }

const compile = (tree, pattern) => {
  const prog = [];
  const emit = (ins) => {
    if (prog.length >= MAX_PROGRAM) unsupported(pattern, 'pattern of this size');
    prog.push(ins);
    return prog.length - 1;
  };

  const gen = (node) => {
    switch (node.t) {
      case 'char': emit({ op: 'char', test: node.test }); break;
      case 'assert': emit({ op: 'assert', kind: node.kind }); break;
      case 'notahead': emit({ op: 'notahead', test: node.test }); break;
      case 'seq': node.items.forEach(gen); break;
      case 'alt': {
        const jumps = [];
        node.options.forEach((option, k) => {
          if (k < node.options.length - 1) {
            const split = emit({ op: 'split' });
            prog[split].x = prog.length;
            gen(option);
            jumps.push(emit({ op: 'jmp' }));
            prog[split].y = prog.length;
          } else {
            gen(option);
          }
        });
        jumps.forEach((j) => { prog[j].x = prog.length; });
        break;
      }
      case 'rep': {
        for (let k = 0; k < node.min; k += 1) gen(node.node);
        if (node.max === Infinity) {
          const split = emit({ op: 'split' });
          prog[split].x = prog.length;
          gen(node.node);
          emit({ op: 'jmp', x: split });
          prog[split].y = prog.length;
        } else {
          const splits = [];
          for (let k = node.min; k < node.max; k += 1) {
            const split = emit({ op: 'split' });
            prog[split].x = prog.length;
            splits.push(split);
            gen(node.node);
          }
          splits.forEach((s) => { prog[s].y = prog.length; });
        }
        break;
      }
      default: throw new TypeError(node.t);
    }
  };

  gen(tree);
  emit({ op: 'match' });
  return prog;
};

// ---------------------------------------------------------------------------------------------
// Simulation

const assertionHolds = (kind, text, pos) => {
  switch (kind) {
    case '^': return pos === 0;
    case '$': return pos === text.length;
    case 'b': return isWord(text[pos - 1]) !== isWord(text[pos]);
    default: return isWord(text[pos - 1]) === isWord(text[pos]); // B
  }
};

const run = (prog, text) => {
  const seen = new Int32Array(prog.length).fill(-1);
  let generation = 0;

  const addThread = (list, pc, pos) => {
    const stack = [pc];
    while (stack.length) {
      const p = stack.pop();
      if (seen[p] !== generation) {
        seen[p] = generation;
        const ins = prog[p];
        if (ins.op === 'jmp') stack.push(ins.x);
        else if (ins.op === 'split') stack.push(ins.y, ins.x);
        else if (ins.op === 'assert') {
          if (assertionHolds(ins.kind, text, pos)) stack.push(p + 1);
        } else if (ins.op === 'notahead') {
          if (!ins.test(text[pos])) stack.push(p + 1);
        } else list.push(p);
      }
    }
  };

  let current = [];
  addThread(current, 0, 0);
  for (let pos = 0; pos <= text.length; pos += 1) {
    if (pos === text.length) return current.some((p) => prog[p].op === 'match');
    generation += 1;
    const nextList = [];
    const c = text[pos];
    for (let k = 0; k < current.length; k += 1) {
      const ins = prog[current[k]];
      if (ins.op === 'char' && ins.test(c)) addThread(nextList, current[k] + 1, pos + 1);
    }
    if (nextList.length === 0) return false;
    current = nextList;
  }
  return false;
};

// ---------------------------------------------------------------------------------------------
// Bounded backtracking, only for lookaround and backreferences.

// Work exponent: unbounded quantifiers + lookarounds + backreferences, and whether any
// quantifier is nested inside another quantified group.
const quantifierShape = (pattern) => {
  let count = 0;
  let nested = false;
  const groups = [];
  let lastGroupHadQuantifier = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') {
      if (/[1-9k]/.test(pattern[i + 1])) count += 1; // a backreference re-reads text
      i += 1;
    } else if (c === '(' && /^\(\?<?[=!]/.test(pattern.slice(i))) {
      count += 1; // a lookaround re-reads text
      groups.push(false);
    } else if (c === '[') {
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
    } else if (c === '(') {
      groups.push(false);
    } else if (c === ')') {
      lastGroupHadQuantifier = groups.pop() ?? false;
      const next = pattern[i + 1];
      if ((next === '*' || next === '+' || next === '{' || next === '?') && lastGroupHadQuantifier) nested = true;
      if (groups.length && lastGroupHadQuantifier) groups[groups.length - 1] = true;
    } else if (c === '*' || c === '+' || (c === '{' && /^\{\d+,\}/.test(pattern.slice(i)))) {
      count += 1;
      if (groups.length) groups[groups.length - 1] = true;
    } else if (c === '{' || c === '?') {
      if (groups.length) groups[groups.length - 1] = true;
    }
  }
  return { count, nested };
};

const toJavaScript = (pattern) => {
  let flags = 'u';
  let source = pattern.replace(/^\(\?([is]+)\)/, (_, f) => {
    flags += f;
    return '';
  });
  source = source.replace(/\\([pP])\{(\w+)\}/g, (m, p, name) => {
    const js = propertySource(name);
    if (!js) unsupported(pattern, `character property \\p{${name}}`);
    if (p === 'p') return js;
    return js.startsWith('[') ? `[^${js.slice(1)}` : `\\P${js.slice(2)}`;
  });
  return { source, flags };
};

const backtrackingMatch = (text, pattern) => {
  const { count, nested } = quantifierShape(pattern);
  if (nested) unsupported(pattern, 'lookaround or backreference combined with nested quantifiers');
  if (text.length ** Math.max(count, 1) > MAX_BACKTRACKING_WORK) {
    unsupported(pattern, `lookaround or backreference on ${text.length} characters`);
  }
  const { source, flags } = toJavaScript(pattern);
  let re;
  try {
    re = new RegExp(`^(?:${source})$`, flags);
  } catch (e) {
    invalid(pattern, e.message);
  }
  return re.test(text);
};

const cache = new Map();

export const fullMatch = (text, pattern) => {
  let prog = cache.get(pattern);
  if (prog === undefined) {
    try {
      prog = compile(parsePattern(pattern), pattern);
    } catch (e) {
      if (!(e instanceof NeedsBacktracking)) throw e;
      prog = null;
    }
    if (cache.size > 200) cache.clear();
    cache.set(pattern, prog);
  }
  return prog ? run(prog, Array.from(text)) : backtrackingMatch(text, pattern);
};
