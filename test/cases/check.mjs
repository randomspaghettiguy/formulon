// Runs one test case and decides Pass/Fail. Shared by formulas.spec.js (vitest) and
// scripts/cases-report.mjs (which writes Status back into the case file).
import { evaluate } from '../../src/formulon.js';

// Test-only shorthands that keep huge adversarial inputs out of the case file:
//   formula: {{repeat:"(":5000}}  ->  "(" repeated 5,000 times
//   field value: {"$repeat":"a","times":n,"prefix":"","suffix":"!"}
export const expandFormula = (formula) => formula.replace(
  /\{\{repeat:("(?:[^"\\]|\\.)*"):(\d+)\}\}/g,
  (_, unit, times) => JSON.parse(unit).repeat(Number(times)),
);
const expandValue = (value) => (value && typeof value === 'object' && '$repeat' in value
  ? `${value.prefix ?? ''}${value.$repeat.repeat(value.times)}${value.suffix ?? ''}`
  : value);
export const expandInputs = (inputs = {}) => Object.fromEntries(
  Object.entries(inputs).map(([name, spec]) => [name, { ...spec, value: expandValue(spec.value) }]),
);

const pad = (n, width = 2) => String(n).padStart(width, '0');

// A result in the same encoding as Expected Results values.
export const describeResult = (result) => {
  if (result.type === 'error') return `error: ${result.errorType}`;
  const { dataType, value } = result;
  if (value === null || value === undefined || value === '') return `${dataType}: (blank)`;
  let shown = value;
  if (dataType === 'date') shown = `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  if (dataType === 'datetime') shown = value.toISOString();
  if (dataType === 'time') shown = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}.${pad(value.getUTCMilliseconds(), 3)}`;
  return `${dataType}: ${JSON.stringify(shown)}`;
};

const sameNumber = (a, e) => Math.abs(a - e) <= 1e-9 * Math.max(1, Math.abs(e));

export const matches = (c, result) => {
  if (c.expected_type === 'error') return result.type === 'error' && result.errorType === c.expected_value;
  if (result.type === 'error') return false;
  const actual = result.value;
  const blank = actual === null || actual === undefined || actual === '';
  if (c.expected_value === null) return blank;
  if (blank) return false;
  if (result.dataType !== c.expected_type) return false;
  switch (c.expected_type) {
    case 'number': return sameNumber(actual, c.expected_value);
    case 'checkbox':
    case 'text':
    case 'html': return actual === c.expected_value;
    case 'datetime': return actual.toISOString() === new Date(c.expected_value).toISOString();
    case 'date':
    case 'time': return describeResult(result) === `${c.expected_type}: ${JSON.stringify(c.expected_value)}`;
    default: return JSON.stringify(actual) === JSON.stringify(c.expected_value);
  }
};

const prepared = new WeakMap();
const argsFor = (c) => {
  if (!prepared.has(c)) {
    const { maxMs: _maxMs, ...options } = c.options;
    if (options.prior) options.prior = expandInputs(options.prior);
    prepared.set(c, [expandFormula(c.formula), expandInputs(c.inputs), options]);
  }
  return prepared.get(c);
};

// { pass, result, bestMs, reason }
export const runCase = (c) => {
  const args = argsFor(c);
  const result = evaluate(...args);
  if (!matches(c, result)) {
    return { pass: false, result, reason: `Actual result: ${describeResult(result)}${result.message ? ` (${result.message})` : ''}` };
  }
  if (c.options.maxMs) {
    let best = Infinity;
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      evaluate(...args);
      best = Math.min(best, performance.now() - start);
    }
    if (best >= c.options.maxMs) return { pass: false, result, bestMs: best, reason: `Took ${best.toFixed(1)} ms; budget ${c.options.maxMs} ms` };
    return { pass: true, result, bestMs: best };
  }
  return { pass: true, result };
};
