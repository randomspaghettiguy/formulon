// Random formulas, valid and invalid, must never throw, never report an internal error and never
// take long. Deterministic by default; set FUZZ_SEED / FUZZ_COUNT to explore further.
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/formulon.js';
import { OVERLOADS } from '../src/signatures.js';

const SEED = Number(process.env.FUZZ_SEED ?? 20261005);
const COUNT = Number(process.env.FUZZ_COUNT ?? 4000);
const BUDGET_MS = 50;

// mulberry32
const rng = (seed) => {
  let a = seed >>> 0;  
  return () => {
     
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
     
  };
};

const INPUTS = {
  Num__c: { type: 'number', value: 42.5 },
  Neg__c: { type: 'number', value: -3 },
  Zero__c: { type: 'number', value: 0 },
  BlankNum__c: { type: 'number', value: null },
  Txt__c: { type: 'text', value: 'Hello, Wörld 👋' },
  BlankTxt__c: { type: 'text', value: null },
  Flag__c: { type: 'checkbox', value: true },
  Day__c: { type: 'date', value: '2024-02-29' },
  BlankDay__c: { type: 'date', value: null },
  Stamp__c: { type: 'datetime', value: '2026-10-05T08:30:00.000Z' },
  Clock__c: { type: 'time', value: '23:59:59.999' },
  Stage: { type: 'picklist', value: 'Closed Won' },
  Multi__c: { type: 'multipicklist', value: ['a', 'b'] },
  Where__c: { type: 'geolocation', value: [37.77, -122.42] },
};

const LITERALS = {
  N: ['0', '1', '-1', '0.5', '1e3', '999999999999', '-0.000001', 'Num__c', 'Neg__c', 'Zero__c', 'BlankNum__c', '(1/3)', 'NULL'],
  T: ['""', '"a"', '" padded "', '"Ünïcödé 🎉"', '"(a+)+"', '"\\\\d+"', 'Txt__c', 'BlankTxt__c', '"1,000"', '"2026-01-31"', '"12:30:00.000"', 'NULL'],
  B: ['TRUE', 'FALSE', 'Flag__c', 'NULL'],
  D: ['DATE(2024,2,29)', 'DATE(1700,1,1)', 'DATE(4000,12,31)', 'Day__c', 'BlankDay__c', 'TODAY()'],
  DT: ['NOW()', 'Stamp__c', 'DATETIMEVALUE("2026-01-01 00:00:00")'],
  TM: ['TIMENOW()', 'Clock__c', 'TIMEVALUE("00:00:00.000")'],
  P: ['Stage'],
  MP: ['Multi__c'],
  G: ['Where__c', 'GEOLOCATION(0,0)'],
};
const ALL_TYPES = Object.keys(LITERALS);
const NAMES = Object.keys(OVERLOADS).filter((n) => /^[a-z0-9]+$/.test(n));

const generate = (random) => {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const expr = (type, depth) => {
    if (depth <= 0 || random() < 0.35) return pick(LITERALS[type] ?? LITERALS.T);
    // Mostly well-typed calls, sometimes deliberately wrong types or arity.
    const name = pick(NAMES);
    const overloads = OVERLOADS[name] ?? [{ params: [{ type: 'X' }, { type: 'X' }, { type: 'X' }] }];
    const { params } = pick(overloads);
    const count = random() < 0.1 ? Math.floor(random() * 5) : params.length + (params.at(-1)?.variadic ? Math.floor(random() * 3) : 0);
    const args = Array.from({ length: count }, (_, i) => {
      const p = params[Math.min(i, params.length - 1)];
      let t = p?.type ?? 'N';
      if (t === 'X' || t === 'A' || t === 'S' || random() < 0.1) t = pick(ALL_TYPES);
      if (t === 'H' || t === 'I') t = 'T';
      return expr(t, depth - 1);
    });
    const op = random();
    if (op < 0.05) return `(${expr('N', depth - 1)} ${pick(['+', '-', '*', '/', '^'])} ${expr('N', depth - 1)})`;
    if (op < 0.08) return `(${expr('T', depth - 1)} & ${expr('T', depth - 1)})`;
    if (op < 0.11) return `(${expr(pick(ALL_TYPES), depth - 1)} ${pick(['=', '<>', '<', '>=', '&&', '||'])} ${expr(pick(ALL_TYPES), depth - 1)})`;
    return `${random() < 0.5 ? name.toUpperCase() : name}(${args.join(', ')})`;
  };
  return expr(pick(ALL_TYPES), 1 + Math.floor(random() * 5));
};

const MUTATIONS = ['(', ')', ',', '"', "'", '\\', '/*', '*/', '+', '-', '&&', '!', '.', '$', '[', ']', '1.', ' ', '\n', 'IF(', 'NULL', ' '];
const mutate = (formula, random) => {
  const chars = Array.from(formula);
  const edits = 1 + Math.floor(random() * 3);
  for (let i = 0; i < edits; i += 1) {
    const at = Math.floor(random() * (chars.length + 1));
    const action = random();
    if (action < 0.4) chars.splice(at, 1);
    else if (action < 0.8) chars.splice(at, 0, MUTATIONS[Math.floor(random() * MUTATIONS.length)]);
    else chars.splice(at, 2, chars[at + 1] ?? '', chars[at] ?? '');
  }
  return chars.join('');
};

const check = (formula, options) => {
  const start = performance.now();
  let result;
  expect(() => { result = evaluate(formula, INPUTS, options); }, formula).not.toThrow();
  const elapsed = performance.now() - start;
  expect(['literal', 'error'], formula).toContain(result.type);
  expect(result.errorType, `${formula}\n${result.message}`).not.toBe('InternalError');
  expect(elapsed, `${formula} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BUDGET_MS);
};

describe(`fuzz (seed ${SEED}, ${COUNT} formulas x 3)`, () => {
  it('generated formulas never throw, never hang, never fail internally', () => {
    const random = rng(SEED);
    for (let i = 0; i < COUNT; i += 1) {
      const formula = generate(random);
      check(formula, { now: '2026-10-05T08:30:00.000Z', blankAs: random() < 0.5 ? 'zero' : 'blank' });
      check(mutate(formula, random), { now: '2026-10-05T08:30:00.000Z' });
    }
  });

  it('random bytes never throw', () => {
    const random = rng(SEED + 1);
    const alphabet = 'IFCASEANDORNOT()1234567890.,+-*/^&|!=<>"\'\\ \n\t$_[]{}abcxyzTRUENULL';
    for (let i = 0; i < COUNT; i += 1) {
      const length = Math.floor(random() * 60);
      const formula = Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
      check(formula, {});
    }
  });
});
