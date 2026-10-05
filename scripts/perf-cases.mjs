// Writes the performance cases (category "performance") as JSONL for cases-to-csv.mjs.
// Every row carries options.maxMs: the case fails if its best of 5 runs exceeds the budget.
// Budgets are generous for CI machines; on a laptop each case runs well under a tenth of it.
import { writeFileSync } from 'node:fs';

const cases = [];
let seq = 0;
const add = (fn, description, formula, expectedType, expectedValue, maxMs, inputs = {}, extra = {}) => {
  seq += 1;
  cases.push({
    id: `PERF-${fn}-${String(seq).padStart(3, '0')}`,
    category: 'performance',
    function: fn,
    description,
    formula,
    inputs,
    options: { maxMs, ...extra },
    expected_type: expectedType,
    expected_value: expectedValue,
    source: 'derived: no input may hang the host app; budget enforced by the test runner',
    confidence: 'derived',
  });
};
const rep = (s, n) => s.repeat(n);
const text = (value) => ({ type: 'text', value });
const big = (unit, times, suffix = '') => ({ type: 'text', value: { $repeat: unit, times, suffix } });

// Parser: the original grammar doubled its time for every nested IF.
add('IF', '20 nested IFs (took 8 s in upstream formulon)', `${rep('IF(TRUE,', 20)}1${rep(',0)', 20)}`, 'number', 1, 20);
add('IF', '480 nested IFs, the most that fits in 3,900 characters', `${rep('IF(TRUE,', 480)}1${rep(',0)', 480)}`, 'number', 1, 50);
add('IF', '60-level realistic IF chain with AND/ISBLANK conditions',
  `${Array.from({ length: 60 }, (_, i) => `IF(AND(Amount > ${i * 100}, NOT(ISBLANK(Name))), "Tier ${i}", `).join('')}"none"${rep(')', 60)}`,
  'text', 'Tier 0', 50, { Amount: { type: 'number', value: 50 }, Name: text('Acme') });
add('IF', '400 nested IFs where the false branch is taken every time', `${rep('IF(FALSE,0,', 400)}7${rep(')', 400)}`, 'number', 7, 50);
add('PARENTHESES', '1,000 nested parentheses', `${rep('(', 1000)}1${rep(')', 1000)}`, 'number', 1, 50);
add('PARENTHESES', '5,000 nested parentheses: rejected as too deep, no stack overflow', `{{repeat:"(":5000}}1{{repeat:")":5000}}`, 'error', 'SyntaxError', 50);
add('ABS', '700 nested function calls', `${rep('ABS(', 700)}-1${rep(')', 700)}`, 'number', 1, 50);
add('+', '3,900-character sum of 1,950 terms', rep('1+', 1949) + '1', 'number', 1950, 50);
add('&', '1,000-term text concatenation', rep('"ab"&', 999) + '"ab"', 'text', rep('ab', 1000), 50);
add('CASE', 'CASE with 1,000 branches, matching the last one', `CASE(999, ${Array.from({ length: 1000 }, (_, i) => `${i}, "v${i}"`).join(', ')}, "none")`, 'text', 'v999', 50);
add('SYNTAX', '100,000-character formula with an unterminated string at the end', `1 + {{repeat:"1 + ":24000}}"abc`, 'error', 'SyntaxError', 100);
add('SYNTAX', '200,000-character formula is rejected before parsing', `{{repeat:"1+":100000}}1`, 'error', 'SyntaxError', 50);
add('COMMENTS', 'formula made of 2,000 comments', `${rep('/* comment */ ', 2000)}1`, 'number', 1, 50);
add('FIELDS', '500 different field references', Array.from({ length: 500 }, (_, i) => `F${i}__c`).join(' + '), 'number', 500, 50,
  Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`F${i}__c`, { type: 'number', value: 1 }])));

// REGEX: JavaScript's backtracking engine takes minutes on these.
add('REGEX', 'nested quantifier (a+)+ on 30 a\'s and a mismatch', 'REGEX(T, "(a+)+")', 'checkbox', false, 50, { T: big('a', 30, '!') });
add('REGEX', 'nested quantifier (a+)+ on 10,000 a\'s and a mismatch', 'REGEX(T, "(a+)+")', 'checkbox', false, 200, { T: big('a', 10000, '!') });
add('REGEX', 'overlapping alternation (a|aa)* on 5,000 a\'s and a mismatch', 'REGEX(T, "(a|aa)*")', 'checkbox', false, 200, { T: big('a', 5000, 'b') });
add('REGEX', 'overlapping alternation (a|a)*b', 'REGEX(T, "(a|a)*b")', 'checkbox', false, 200, { T: big('a', 5000) });
add('REGEX', '(.*a){20} on 2,000 a\'s', 'REGEX(T, "(.*a){20}")', 'checkbox', true, 300, { T: big('a', 2000) });
add('REGEX', 'email-style pattern on a 5,000-character near miss', 'REGEX(T, "^([a-zA-Z0-9_.+-])+@(([a-zA-Z0-9-])+\\\\.)+([a-zA-Z0-9]{2,4})+$")', 'checkbox', false, 300, { T: big('a', 5000, '@') });
add('REGEX', 'simple class over the largest text (131,072 characters)', 'REGEX(T, "[a-z]*")', 'checkbox', true, 500, { T: big('a', 131072) });
add('REGEX', 'repetition {1000}', 'REGEX(T, "a{1000}")', 'checkbox', true, 200, { T: big('a', 1000) });
add('REGEX', 'repetition above the limit is refused, not attempted', 'REGEX(T, "a{100000}")', 'error', 'NotSupportedError', 50, { T: text('a') });
add('REGEX', 'backreference on a short text runs (bounded backtracking)', 'REGEX(T, "(a+)\\\\1")', 'checkbox', true, 50, { T: big('a', 100) });
add('REGEX', 'backreference on 10,000 characters is refused, not attempted', 'REGEX(T, "(a+)\\\\1")', 'error', 'NotSupportedError', 50, { T: big('a', 10000, '!') });
add('REGEX', 'lookahead password rule on a long text is refused, not attempted', 'REGEX(T, "(?=.*\\\\d)(?=.*[a-z]).{8,}")', 'error', 'NotSupportedError', 50, { T: big('a', 5000) });
add('REGEX', 'lookahead with nested quantifiers is refused even on short text', 'REGEX(T, "(?=a)(a+)+")', 'error', 'NotSupportedError', 50, { T: big('a', 30, '!') });

// Text: quadratic regexes and unbounded allocation.
add('TRIM', '131,000 spaces then a letter (quadratic for /\\s+$/)', 'LEN(TRIM(T))', 'number', 1, 100, { T: big(' ', 131000, 'a') });
add('TRIM', 'letter, 131,000 spaces, letter', 'LEN(TRIM(T))', 'number', 131002, 100, { T: { type: 'text', value: { $repeat: ' ', times: 131000, prefix: 'a', suffix: 'b' } } });
add('VALUE', '100,000 digits then a letter (quadratic for /\\d+\\.?\\d*/)', 'VALUE(T)', 'number', null, 100, { T: big('1', 100000, 'x') });
add('ISNUMBER', '100,000 digits then a letter', 'ISNUMBER(T)', 'checkbox', false, 100, { T: big('1', 100000, 'x') });
add('LPAD', 'LPAD to one billion characters is refused before allocating', 'LPAD("a", 1000000000)', 'error', 'RuntimeError', 50);
add('RPAD', 'RPAD to the largest text length', 'LEN(RPAD("a", 131072, "xy"))', 'number', 131072, 100);
add('SUBSTITUTE', 'nested SUBSTITUTE multiplying length 10x per level is refused', `${rep('SUBSTITUTE(', 6)}T${rep(', "a", "aaaaaaaaaa")', 6)}`, 'error', 'RuntimeError', 100, { T: big('a', 1000) });
add('SUBSTITUTE', 'SUBSTITUTE on the largest text', 'LEN(SUBSTITUTE(T, "a", "b"))', 'number', 131072, 100, { T: big('a', 131072) });
add('&', 'concatenation past the largest text length is refused', 'T & T', 'error', 'RuntimeError', 100, { T: big('a', 100000) });
add('FIND', 'FIND at the end of the largest text', 'FIND("b", T)', 'number', 131072, 100, { T: big('a', 131071, 'b') });
add('MID', 'MID in the largest text', 'LEN(MID(T, 1000, 100000))', 'number', 100000, 100, { T: big('a', 131072) });
add('LEN', 'LEN of the largest text', 'LEN(T)', 'number', 131072, 100, { T: big('a', 131072) });
add('REVERSE', 'REVERSE of the largest text', 'LEN(REVERSE(T))', 'number', 131072, 100, { T: big('ab', 65536) });
add('INITCAP', 'INITCAP of 20,000 words', 'LEN(INITCAP(T))', 'number', 120000, 100, { T: big('word. ', 20000) });

// Numbers and dates that would overflow.
add('^', '10^400 overflows: an error, not Infinity', '10^400', 'error', 'RuntimeError', 50);
add('ADDMONTHS', 'ADDMONTHS by 10^12 months', 'ADDMONTHS(DATE(2020,1,1), 1000000000000)', 'error', 'RuntimeError', 50);
add('DATEMATH', 'date plus 10^15 days', 'DATE(2020,1,1) + 1000000000000000', 'error', 'RuntimeError', 50);
add('FROMUNIXTIME', 'FROMUNIXTIME(10^18)', 'FROMUNIXTIME(1000000000000000000)', 'error', 'RuntimeError', 50);
add('INCLUDES', 'INCLUDES over a multi-select with 1,000 selected values', 'INCLUDES(M, "v999")', 'checkbox', true, 50,
  { M: { type: 'multipicklist', value: Array.from({ length: 1000 }, (_, i) => `v${i}`) } });
add('MAX', 'MAX of 1,000 arguments', `MAX(${Array.from({ length: 1000 }, (_, i) => i).join(',')})`, 'number', 999, 50);

writeFileSync(process.argv[2] ?? 'perf.jsonl', cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
console.log(`${cases.length} performance cases`);
