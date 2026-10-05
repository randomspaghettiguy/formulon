// Runs every case in test/cases/formula-test-cases.csv and records the outcome in the file
// itself: Status (Pass/Fail), Test Executed by, Date of the Test Execution, and for a failure the
// actual result in Notes. Prints a summary. Exit code 1 when any case fails.
import { readFileSync, writeFileSync } from 'node:fs';
import { readCaseFile, writeCaseFile, COLUMNS } from '../test/cases/format.mjs';
import { runCase } from '../test/cases/check.mjs';

const FILE = new URL('../test/cases/formula-test-cases.csv', import.meta.url);
const cases = readCaseFile(readFileSync(FILE, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const tally = {};
const failures = [];

const rows = cases.map((c) => {
  const { pass, reason } = runCase(c);
  const status = pass ? 'Pass' : 'Fail';
  const t = (tally[c.category] ??= { Pass: 0, Fail: 0, 'needs-org': 0 });
  t[status] += 1;
  if (c.confidence === 'needs-org') t['needs-org'] += 1;
  if (!pass) failures.push(`${c.id}: ${reason}`);
  const notes = c.row['Notes/Comments/Questions'].split('\n').filter((l) => !l.startsWith('Actual result:') && !l.startsWith('Took ')).join('\n');
  return {
    ...Object.fromEntries(COLUMNS.map((k) => [k, c.row[k]])),
    'Test Executed by': 'Automated (npm run cases:report)',
    'Date of the Test Execution': today,
    'Status (Fail/Pass)': status,
    'Notes/Comments/Questions': pass ? notes : `${notes}\n${reason}`,
  };
});

writeFileSync(FILE, writeCaseFile(rows));
const total = Object.values(tally).reduce((a, t) => ({ Pass: a.Pass + t.Pass, Fail: a.Fail + t.Fail, n: a.n + t['needs-org'] }), { Pass: 0, Fail: 0, n: 0 });
console.log('category      pass  fail  unverified(needs-org)');
Object.entries(tally).forEach(([k, t]) => console.log(`${k.padEnd(12)} ${String(t.Pass).padStart(5)} ${String(t.Fail).padStart(5)} ${String(t['needs-org']).padStart(6)}`));
console.log(`${'total'.padEnd(12)} ${String(total.Pass).padStart(5)} ${String(total.Fail).padStart(5)} ${String(total.n).padStart(6)}`);
if (failures.length) { console.log(`\n${failures.join('\n')}`); process.exitCode = 1; }
