// Checks CSV cases against real Salesforce, using Apex's own formula evaluator (FormulaEval).
//
//   node scripts/verify-org.mjs                     # writes tmp/verify-org/*.apex, runs nothing
//   node scripts/verify-org.mjs --org <alias>        # runs them with `sf apex run` and reports
//   node scripts/verify-org.mjs --org <alias> --all  # every eligible case, not only needs-org
//
// Read-only: each formula is evaluated against an in-memory `new Account()`; no record is
// queried, created or changed. Eligible cases are those without field inputs or a clock (TODAY,
// NOW, TIMENOW), since an empty Account has no custom fields to feed them.
//
// Output: test/cases/org-verification.csv — expected value, Salesforce's value, and whether they
// match. Mismatches are for a human to review; the case file is never changed automatically.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readCaseFile } from '../test/cases/format.mjs';

const args = process.argv.slice(2);
const org = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;
const all = args.includes('--all');
const CHUNK = 40;

const RETURN_TYPES = {
  number: ['DECIMAL'],
  text: ['STRING'],
  checkbox: ['BOOLEAN'],
  date: ['DATE'],
  datetime: ['DATETIME'],
  time: ['TIME'],
  // For an expected error, try every type: the error must hold whatever the field type is.
  error: ['DECIMAL', 'STRING', 'BOOLEAN', 'DATE', 'DATETIME', 'TIME'],
};

const rows = readCaseFile(readFileSync(new URL('../test/cases/formula-test-cases.csv', import.meta.url), 'utf8'))
  .filter((r) => all || r.confidence === 'needs-org')
  .filter((r) => Object.keys(r.inputs).length === 0 && RETURN_TYPES[r.expected_type])
  .filter((r) => !/\b(TODAY|NOW|TIMENOW)\s*\(/i.test(r.formula) && !r.formula.includes('{{repeat'))
  .filter((r) => { const o = r.options; return !o.prior && !o.isNew && !o.isClone && !o.context && !o.maxMs; });

const apexString = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}'`;

const apexFor = (chunk) => `
Map<String, FormulaEval.FormulaReturnType> types = new Map<String, FormulaEval.FormulaReturnType>{
  'DECIMAL' => FormulaEval.FormulaReturnType.DECIMAL, 'STRING' => FormulaEval.FormulaReturnType.STRING,
  'BOOLEAN' => FormulaEval.FormulaReturnType.BOOLEAN, 'DATE' => FormulaEval.FormulaReturnType.DATE,
  'DATETIME' => FormulaEval.FormulaReturnType.DATETIME, 'TIME' => FormulaEval.FormulaReturnType.TIME
};
List<List<String>> cases = new List<List<String>>{
${chunk.map((r) => `  new List<String>{ ${apexString(r.id)}, ${apexString(r.formula)}, ${apexString(RETURN_TYPES[r.expected_type].join(','))} }`).join(',\n')}
};
for (List<String> c : cases) {
  String outcome = '';
  for (String t : c[2].split(',')) {
    try {
      FormulaEval.FormulaInstance f = Formula.builder()
        .withType(Account.SObjectType).withReturnType(types.get(t)).withFormula(c[1]).build();
      Object v = f.evaluate(new Account());
      String shown = v == null ? '<blank>'
        : (v instanceof Datetime ? ((Datetime) v).formatGmt('yyyy-MM-dd\\'T\\'HH:mm:ss.SSS\\'Z\\'')
        : (v instanceof Date ? String.valueOf(v).left(10) : String.valueOf(v)));
      outcome = 'OK|' + t + '|' + shown.replace('\\n', '\\\\n');
      break;
    } catch (Exception e) {
      outcome = 'ERR|' + e.getTypeName() + '|' + e.getMessage().replace('\\n', ' ');
    }
  }
  System.debug(LoggingLevel.ERROR, 'F1CASE|' + c[0] + '|' + outcome);
}
`;

const dir = new URL('../tmp/verify-org/', import.meta.url);
mkdirSync(dir, { recursive: true });
const chunks = [];
for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));
chunks.forEach((chunk, i) => writeFileSync(new URL(`chunk-${String(i + 1).padStart(3, '0')}.apex`, dir), apexFor(chunk)));
console.log(`${rows.length} eligible cases in ${chunks.length} Apex files under tmp/verify-org/`);

if (!org) {
  console.log('Dry run. Pass --org <alias> to run them against an org (read-only).');
  process.exit(0);
}

const results = new Map();
chunks.forEach((_, i) => {
  const file = new URL(`chunk-${String(i + 1).padStart(3, '0')}.apex`, dir).pathname;
  const out = execFileSync('sf', ['apex', 'run', '--file', file, '--target-org', org, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const json = JSON.parse(out);
  const logs = json.result?.logs ?? '';
  if (!json.result?.success) console.error(`chunk ${i + 1}: ${json.result?.compileProblem || json.result?.exceptionMessage || 'failed'}`);
  for (const line of logs.split('\n')) {
    const m = /F1CASE\|([^|]+)\|(OK|ERR)\|([^|]*)\|(.*)$/.exec(line);
    if (m) results.set(m[1], { status: m[2], kind: m[3], value: m[4] });
  }
  process.stdout.write(`chunk ${i + 1}/${chunks.length} done\n`);
});

const agree = (row, r) => {
  if (!r) return 'not-run';
  if (row.expected_type === 'error') return r.status === 'ERR' ? 'match' : 'MISMATCH';
  if (r.status === 'ERR') return 'MISMATCH';
  const got = r.value === '<blank>' ? null : r.value;
  const want = row.expected_value;
  if (want === null || got === null) return want === got || (got === '' && want === null) ? 'match' : 'MISMATCH';
  if (row.expected_type === 'number') {
    return Math.abs(Number(got) - want) <= 1e-9 * Math.max(1, Math.abs(want)) ? 'match' : 'MISMATCH';
  }
  if (row.expected_type === 'checkbox') return got.toLowerCase() === String(want) ? 'match' : 'MISMATCH';
  if (row.expected_type === 'datetime') return new Date(got).toISOString() === new Date(want).toISOString() ? 'match' : 'MISMATCH';
  return got === want ? 'match' : 'MISMATCH';
};

const quote = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
const report = ['id,formula,expected_type,expected_value,org_status,org_value,verdict'];
let mismatches = 0;
rows.forEach((row) => {
  const r = results.get(row.id);
  const verdict = agree(row, r);
  if (verdict === 'MISMATCH') mismatches += 1;
  report.push([row.id, row.formula, row.expected_type, JSON.stringify(row.expected_value), r ? `${r.status} ${r.kind}` : '', r?.value ?? '', verdict].map(quote).join(','));
});
writeFileSync(new URL('../test/cases/org-verification.csv', import.meta.url), `${report.join('\n')}\n`);
console.log(`${rows.length - mismatches} agree, ${mismatches} disagree. See test/cases/org-verification.csv`);
