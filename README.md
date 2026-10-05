# formulon (force1 fork)

Evaluates Salesforce formulas in JavaScript: give it a formula and the record's field values, get
back the value Salesforce would compute. Forked from [leifg/formulon](https://github.com/leifg/formulon)
and reworked to cover every documented function, match Salesforce's documented behaviour, and never
hang the page that calls it.

- **Every formula function**: all 104 functions and 15 operators from Salesforce's *Formula Operators
  and Functions* reference (Winter '27). Functions that only work inside a live org (VLOOKUP,
  GETSESSIONID, URLFOR, report summaries...) take an implementation from the host, and otherwise
  report `NotSupportedError` instead of inventing a value.
- **2,490 test cases** in [`test/cases/formula-test-cases.csv`](test/cases/formula-test-cases.csv),
  each tied to the Salesforce documentation it comes from (see *Test cases* below).
- **Cannot hang**: a single-pass parser, a linear-time regular expression engine, size caps checked
  before allocating, and a time budget on 47 adversarial performance cases.
- **Never throws**: problems come back as `{ type: 'error', errorType, message }`.
- **Light**: no dependencies, 15 KB gzipped, ES module + CommonJS, TypeScript types.

## Usage

```js
import { evaluate, compile } from 'formulon';

evaluate('IF(Amount > 1000, "Big", "Small")', { Amount: { type: 'currency', value: 5000 } });
// { type: 'literal', dataType: 'text', value: 'Big', options: { length: 3 } }

evaluate('Amount / Quantity', { Amount: { type: 'number', value: 1 }, Quantity: { type: 'number', value: 0 } });
// { type: 'error', errorType: 'RuntimeError', message: '#Error! Division by zero.' }

// Parse once, evaluate per record
const discount = compile('ROUND(Amount * Discount__c, 2)');
discount.references; // ['Amount', 'Discount__c']
discount.evaluate({ Amount: { type: 'number', value: 99.99 }, Discount__c: { type: 'percent', value: 0.15 } });
```

### Inputs

`{ FieldApiName: { type, value } }`. Names are case-insensitive; cross-object and global references
are dotted names (`Account.Name`, `$User.Id`).

| type | value |
|---|---|
| `number` `currency` `percent` (50% is `0.5`) | number or `null` |
| `text` `textarea` `email` `phone` `url` `id` | string or `null` |
| `checkbox` | `true` / `false` |
| `date` | `'2026-10-05'`, a `Date`, or `null` |
| `datetime` | ISO string, `Date`, or `null` (GMT) |
| `time` | `'13:45:00.000'` or `null` |
| `picklist` | string or `null` |
| `multipicklist` | array of strings, `'a;b'`, or `null` |
| `geolocation` | `[latitude, longitude]` or `null` |

### Options

| option | meaning |
|---|---|
| `now` | clock for `TODAY()`, `NOW()`, `TIMENOW()` (time zone GMT) |
| `blankAs` | the formula field's *Treat blank fields as*: `'blank'` (default) or `'zero'` |
| `returnType`, `scale` | declared return type and decimal places; the result is rounded like the field displays it |
| `prior`, `isNew`, `isClone` | record history for `ISCHANGED`, `PRIORVALUE`, `ISNEW`, `ISCLONE` (validation rules, flows) |
| `context` | host implementations: `sessionId`, `currencyRate(iso)`, `vlookup(...)`, `urlfor(...)`... |

### Results

`{ type: 'literal', dataType, value }` where `dataType` is `number`, `text`, `checkbox`, `date`,
`datetime`, `time`, or:

- `hyperlink`: `value` is `{ url, label, target }` (label may be an image object). Render it as a link
  yourself; never as raw HTML.
- `image`: `value` is `{ url, alt, height, width }`.
- `html`: text joined with links or images (`IMAGE(...) & IMAGE(...)`). Every piece of text in it is
  HTML-escaped, the only tags are the generated `<a>` and `<img>`, and only http(s), mailto, tel, ftp
  and relative URLs become an `href`/`src` (a `javascript:` URL from a field value is dropped), so it
  is safe to render as HTML.

Errors: `SyntaxError`, `ArgumentError` (wrong parameter count or type, which Salesforce reports at save
time), `ReferenceError` (field not given), `NoFunctionError`, `RuntimeError` (`#Error!`: division by
zero, invalid date...), `NotSupportedError` (needs org context), `ReturnTypeError`, and
`InternalError` (a bug here; please report the formula).

## Guarantees against hanging

The library runs inside generated React apps, so a formula must never freeze the page:

- The parser reads each character once. Upstream's generated grammar doubled its time with every
  nested `IF`; 20 levels took 8 seconds.
- `REGEX()` runs on a Pike VM (Thompson NFA): time is bounded by text length x pattern size.
  `(a+)+` on 10,000 characters takes 2 ms; JavaScript's own engine takes minutes. Lookaround and
  backreferences can't be matched in linear time, so they run on `RegExp` only under a proven bound
  (no nested quantifiers, length^quantifiers <= 10^7). Otherwise they report `NotSupportedError`.
- Text is capped at 131,072 characters (Salesforce's largest text field), checked *before* the text is
  built: nested `SUBSTITUTE` or `LPAD("a", 1e9)` return `RuntimeError` instantly.
- Nesting is capped, formulas over 100,000 characters are rejected, and dates are range-checked.
- `test/fuzz.spec.js` throws thousands of random and mutated formulas at it on every run: none may
  throw, report an internal error, or take more than 50 ms.

## Test cases

[`test/cases/formula-test-cases.csv`](test/cases/formula-test-cases.csv) holds every test case in the
standard 18-column test-case template (ID, priority, designer, pre-condition, steps, test data,
expected results, post-condition, status, notes, requirements, references, automation). The automated
runner executes the same file, so the document and the tests cannot drift apart.

| category | cases | what |
|---|---|---|
| syntax | 115 | literals, escapes, comments, field names, function names |
| operator | 202 | every operator, precedence, date/time arithmetic |
| null | 44 | blank fields under both blank-field settings |
| type | 46 | save-time type errors |
| logical | 242 | IF, CASE, AND, OR, ISBLANK, BLANKVALUE, ISCHANGED, PRIORVALUE... |
| math | 449 | all 27 math functions, decimal exactness |
| text | 553 | all 29 text functions |
| datetime | 422 | all 21 date/time functions |
| advanced, summary | 117 | REGEX, CURRENCYRATE, VLOOKUP, URLFOR, report summaries... |
| integration | 241 | Salesforce's sample formulas |
| performance | 47 | adversarial inputs with time budgets |

Each case's *Notes* column gives its confidence: `doc` (stated in Salesforce documentation),
`derived` (follows from documented rules), or `needs-org` (268 cases where the documentation is
silent or contradicts itself; the best guess is implemented and marked UNVERIFIED).

```bash
npm test                        # unit tests, every CSV case, fuzzing
npm run cases:report            # runs the CSV and writes Status / execution date back into it
npm run verify:org              # writes Apex that checks needs-org cases against real Salesforce
npm run verify:org -- --org dev # runs it (read-only: in-memory records only) and writes org-verification.csv
npm run build && npm run size   # bundles and checks the 16 KB gzip budget
```

## Known limits

- Numbers are JavaScript doubles: results are exact to 15 significant digits (Salesforce keeps 18).
  `+ - * /` are rounded back to 15 digits, so `0.1 + 0.2 = 0.3` and `MOD(0.3, 0.1) = 0`.
- Time zone is GMT, as Salesforce evaluates date/time values.
- Operator precedence of `^`: Salesforce samples and the org-tested
  [sformula](https://github.com/stomita/sformula) use textbook precedence (`2*2^3 = 16`), which is
  implemented. Salesforce Known Issue W-7622870 reports 64. The affected cases are `needs-org`.

## Differences from upstream formulon

New parser, static type checker, lazy `IF`, blank-field semantics, 39 functions added, `HYPERLINK`
and `IMAGE` return structured values instead of unescaped HTML, `GETSESSIONID` no longer returns a
made-up session ID, `decimal.js` and Peggy removed, ES module build. The `parse`, `extract` and `ast`
exports still work.
