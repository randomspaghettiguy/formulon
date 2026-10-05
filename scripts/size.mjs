// Fails when the minified, gzipped bundle grows past the budget. The package ships inside
// generated React apps, so every kilobyte counts.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUDGET_GZIP_BYTES = 16 * 1024;
const file = new URL('../lib/formulon.min.mjs', import.meta.url);
const raw = readFileSync(file);
const gz = gzipSync(raw, { level: 9 }).length;
console.log(`lib/formulon.min.mjs: ${(raw.length / 1024).toFixed(1)} KB minified, ${(gz / 1024).toFixed(1)} KB gzipped (budget ${BUDGET_GZIP_BYTES / 1024} KB)`);
if (gz > BUDGET_GZIP_BYTES) {
  console.error('Over the size budget.');
  process.exitCode = 1;
}
