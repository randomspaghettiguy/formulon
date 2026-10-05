// Adds research cases (JSONL, one case object per line) to test/cases/formula-test-cases.csv.
// Usage: node scripts/cases-to-csv.mjs <file.jsonl>...
// Case object: { id, function, description, formula, inputs, options, expected_type,
//                expected_value, source, confidence } — see test/cases/format.mjs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseCsv } from '../test/cases/csv.mjs';
import { COLUMNS, categoryOf, toRow, writeCaseFile } from '../test/cases/format.mjs';

const OUT = new URL('../test/cases/formula-test-cases.csv', import.meta.url);
const ORDER = ['syntax', 'operator', 'null', 'type', 'logical', 'math', 'text', 'datetime', 'advanced', 'summary', 'integration', 'performance'];
const TYPES = ['number', 'text', 'checkbox', 'date', 'datetime', 'time', 'geolocation', 'hyperlink', 'image', 'html', 'error'];
const ERRORS = ['SyntaxError', 'ArgumentError', 'ReferenceError', 'NoFunctionError', 'RuntimeError', 'NotSupportedError', 'ReturnTypeError'];

const rows = existsSync(OUT) ? parseCsv(readFileSync(OUT, 'utf8')) : [];
const seen = new Set(rows.map((r) => r['Test case ID']));
const problems = [];

process.argv.slice(2).forEach((file) => {
  readFileSync(file, 'utf8').split('\n').forEach((line, n) => {
    if (!line.trim()) return;
    const c = JSON.parse(line);
    const where = `${file}:${n + 1} ${c.id}`;
    if (!c.id || seen.has(c.id)) { problems.push(`${where}: missing or duplicate id`); return; }
    if (!TYPES.includes(c.expected_type)) problems.push(`${where}: bad expected_type ${c.expected_type}`);
    if (c.expected_type === 'error' && !ERRORS.includes(c.expected_value)) problems.push(`${where}: bad error ${c.expected_value}`);
    if (!['doc', 'derived', 'needs-org'].includes(c.confidence)) problems.push(`${where}: bad confidence ${c.confidence}`);
    seen.add(c.id);
    rows.push(toRow(c));
  });
});

const rank = (r) => { const i = ORDER.indexOf(categoryOf(r['Test case ID'])); return i === -1 ? 99 : i; };
rows.sort((a, b) => rank(a) - rank(b));
writeFileSync(OUT, writeCaseFile(rows.map((r) => Object.fromEntries(COLUMNS.map((k) => [k, r[k]])))));
console.log(`${rows.length} cases in test/cases/formula-test-cases.csv`);
if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; }
