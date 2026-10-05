// Runs every case in formula-test-cases.csv. The case file, not this code, defines correct
// behaviour; see format.mjs for how its cells are read.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCaseFile } from './format.mjs';
import { runCase } from './check.mjs';

const cases = readCaseFile(readFileSync(new URL('./formula-test-cases.csv', import.meta.url), 'utf8'));

describe(`formula-test-cases.csv (${cases.length} cases)`, () => {
  [...new Set(cases.map((c) => c.category))].forEach((category) => {
    describe(category, () => {
      cases.filter((c) => c.category === category).forEach((c) => {
        const shown = c.formula.length > 80 ? `${c.formula.slice(0, 77)}...` : c.formula;
        it(`${c.id} ${shown}`, () => {
          const { pass, reason } = runCase(c);
          expect(pass, `${c.description}\n  ${c.row['Expected Results']}\n  ${reason}`).toBe(true);
        });
      });
    });
  });
});
