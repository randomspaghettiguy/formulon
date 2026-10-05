// The formula test-case file, formula-test-cases.csv, uses the standard 18-column test-case
// template (ID, priority, designer, steps, test data, expected results, status...). The same file
// is what the automated runner executes, so the readable cells below are also parsed:
//
//   Pre-condition    one setting per line, or "None":
//                      Treat blank fields as: blanks | zeroes
//                      Current time (TODAY/NOW/TIMENOW): 2026-10-05T08:30:00.000Z
//                      Formula return type: number, 2 decimal places
//                      Record is new (ISNEW): true
//                      Record is a clone (ISCLONE): true
//                      Prior value Amount (number) = 100
//                      Session ID: "..."
//   Test Data        "Field <Name> (<type>) = <JSON value>" lines, then a line "Formula:" followed by
//                    the formula exactly as written (it may span several lines)
//   Expected Results "<type>: <JSON value>", "<type>: (blank)" or "error: <ErrorType>"
//   Post-Condition   "... within <n> ms ..." adds a time budget
import { parseCsv, toCsvRows } from './csv.mjs';

export const COLUMNS = [
  'Test case ID',
  'Test Priority',
  'Test Designed by',
  'Date of test designed',
  'Test Executed by',
  'Date of the Test Execution',
  'Name or Test Title',
  'Description/Summary of Test',
  'Pre-condition',
  'Test Steps',
  'Test Data',
  'Expected Results',
  'Post-Condition',
  'Status (Fail/Pass)',
  'Notes/Comments/Questions',
  'Requirements',
  'Attachments/References',
  'Automation? (Yes/No)',
];

const CATEGORY_BY_PREFIX = {
  SYNTAX: 'syntax',
  OPERATOR: 'operator',
  NULL: 'null',
  TYPE: 'type',
  LOGICAL: 'logical',
  MATH: 'math',
  TEXT: 'text',
  DATETIME: 'datetime',
  ADVANCED: 'advanced',
  SUMMARY: 'summary',
  INTEGRATION: 'integration',
  PERF: 'performance',
};
const PRIORITY = {
  performance: 'High',
  syntax: 'High',
  operator: 'High',
  null: 'High',
  type: 'High',
  logical: 'High',
  integration: 'High',
  math: 'Medium',
  text: 'Medium',
  datetime: 'Medium',
  advanced: 'Low',
  summary: 'Low',
};
const REQUIREMENT = {
  performance: 'REQ-PERF: no formula may hang the host app; every evaluation finishes within its time budget',
  syntax: 'REQ-SYNTAX: formulas are parsed exactly as Salesforce parses them',
  operator: 'REQ-OPERATOR: operators and precedence behave as in Salesforce',
  null: 'REQ-BLANK: blank fields behave as in Salesforce under both blank-field settings',
  type: 'REQ-TYPE: type errors Salesforce reports at save time are reported',
  logical: 'REQ-LOGICAL: logical functions behave as in Salesforce',
  math: 'REQ-MATH: math functions behave as in Salesforce',
  text: 'REQ-TEXT: text functions behave as in Salesforce',
  datetime: 'REQ-DATETIME: date and time functions and date arithmetic behave as in Salesforce',
  advanced: 'REQ-ADVANCED: advanced functions behave as in Salesforce, or report that they need org context',
  summary: 'REQ-SUMMARY: report summary functions report that they need report context',
  integration: 'REQ-INTEGRATION: Salesforce sample formulas give the documented results',
};
const CONFIDENCE_NOTE = {
  doc: 'Expected result stated or shown in official Salesforce documentation.',
  derived: 'Expected result derived from documented rules (not stated word for word).',
  'needs-org': 'UNVERIFIED: the documentation is silent or contradictory; this is the best guess. Confirm with scripts/verify-org.mjs against a real org.',
};

export const categoryOf = (id) => CATEGORY_BY_PREFIX[id.split('-')[0]] ?? 'other';

// ---------------------------------------------------------------------------------------------
// Case object <-> row

const fieldLine = (prefix, name, spec) => `${prefix} ${name} (${spec.type}) = ${JSON.stringify(spec.value ?? null)}`;

const preCondition = (options) => {
  const lines = [];
  if (options.blankAs) lines.push(`Treat blank fields as: ${options.blankAs === 'zero' ? 'zeroes' : 'blanks'}`);
  if (options.now) lines.push(`Current time (TODAY/NOW/TIMENOW): ${options.now}`);
  if (options.returnType) {
    lines.push(`Formula return type: ${options.returnType}${Number.isInteger(options.scale) ? `, ${options.scale} decimal places` : ''}`);
  }
  if (options.isNew !== undefined) lines.push(`Record is new (ISNEW): ${options.isNew}`);
  if (options.isClone !== undefined) lines.push(`Record is a clone (ISCLONE): ${options.isClone}`);
  Object.entries(options.prior ?? {}).forEach(([name, spec]) => lines.push(fieldLine('Prior value', name, spec)));
  if (options.context?.sessionId) lines.push(`Session ID: ${JSON.stringify(options.context.sessionId)}`);
  return lines.length ? lines.join('\n') : 'None';
};

const testData = (formula, inputs) => [
  ...Object.entries(inputs).map(([name, spec]) => fieldLine('Field', name, spec)),
  'Formula:',
  formula,
].join('\n');

const expectedResults = (type, value) => {
  if (type === 'error') return `error: ${value}`;
  if (value === null || value === undefined || value === '') return `${type}: (blank)`;
  return `${type}: ${JSON.stringify(value)}`;
};

const STEPS = [
  '1. Apply the pre-conditions.',
  '2. Evaluate the formula in Test Data with the field values in Test Data.',
  '3. Compare the result type and value with Expected Results.',
];

export const toRow = (c, run = {}) => {
  const category = categoryOf(c.id);
  const maxMs = c.options?.maxMs;
  const { maxMs: _, ...options } = c.options ?? {};
  const source = String(c.source ?? '');
  const url = /^https?:\/\//.test(source) ? source : '';
  const reasoning = url ? '' : source.replace(/^(derived|needs-org):\s*/, '');
  return {
    'Test case ID': c.id,
    'Test Priority': PRIORITY[category] ?? 'Medium',
    'Test Designed by': c.designedBy ?? 'Claude (AI), review pending',
    'Date of test designed': c.designedOn ?? '2026-10-05',
    'Test Executed by': run.executedBy ?? c.executedBy ?? '',
    'Date of the Test Execution': run.executedOn ?? c.executedOn ?? '',
    'Name or Test Title': `${c.function}: ${c.title ?? c.description}`.slice(0, 160),
    'Description/Summary of Test': c.description,
    'Pre-condition': preCondition(options),
    'Test Steps': (maxMs ? [...STEPS, '4. Repeat 5 times and take the fastest run.'] : STEPS).join('\n'),
    'Test Data': testData(c.formula, c.inputs ?? {}),
    'Expected Results': expectedResults(c.expected_type, c.expected_value),
    'Post-Condition': maxMs
      ? `The evaluation returns a result, throws nothing, and finishes within ${maxMs} ms.`
      : 'The evaluation returns a result and throws nothing.',
    'Status (Fail/Pass)': run.status ?? c.status ?? 'Not Run',
    'Notes/Comments/Questions': [`Confidence: ${c.confidence}. ${CONFIDENCE_NOTE[c.confidence] ?? ''}`, reasoning, run.note ?? ''].filter(Boolean).join('\n'),
    Requirements: REQUIREMENT[category] ?? '',
    'Attachments/References': url || 'Salesforce Help: Formula Operators and Functions by Context, https://help.salesforce.com/s/articleView?id=platform.customize_functions.htm&type=5',
    'Automation? (Yes/No)': 'Yes',
  };
};

const parseField = (line, prefix) => {
  const m = new RegExp(`^${prefix} (.+?) \\(([a-z]+)\\) = (.*)$`).exec(line);
  if (!m) throw new Error(`Cannot read "${line}"`);
  return [m[1], { type: m[2], value: JSON.parse(m[3]) }];
};

export const fromRow = (row) => {
  const id = row['Test case ID'];
  try {
    const data = row['Test Data'].split('\n');
    const at = data.indexOf('Formula:');
    if (at === -1) throw new Error('Test Data has no "Formula:" line');
    const inputs = Object.fromEntries(data.slice(0, at).filter(Boolean).map((l) => parseField(l, 'Field')));
    const formula = data.slice(at + 1).join('\n');

    const options = {};
    row['Pre-condition'].split('\n').forEach((line) => {
      let m;
      if (line === 'None' || line === '') return;
      if ((m = /^Treat blank fields as: (blanks|zeroes)$/.exec(line))) options.blankAs = m[1] === 'zeroes' ? 'zero' : 'blank';
      else if ((m = /^Current time \(TODAY\/NOW\/TIMENOW\): (.+)$/.exec(line))) options.now = m[1];
      else if ((m = /^Formula return type: (\w+)(?:, (\d+) decimal places)?$/.exec(line))) {
        options.returnType = m[1];
        if (m[2] !== undefined) options.scale = Number(m[2]);
      } else if ((m = /^Record is new \(ISNEW\): (true|false)$/.exec(line))) options.isNew = m[1] === 'true';
      else if ((m = /^Record is a clone \(ISCLONE\): (true|false)$/.exec(line))) options.isClone = m[1] === 'true';
      else if (line.startsWith('Prior value ')) {
        const [name, spec] = parseField(line, 'Prior value');
        options.prior = { ...options.prior, [name]: spec };
      } else if ((m = /^Session ID: (.+)$/.exec(line))) options.context = { sessionId: JSON.parse(m[1]) };
      else throw new Error(`Unknown pre-condition "${line}"`);
    });
    const budget = /within (\d+) ms/.exec(row['Post-Condition']);
    if (budget) options.maxMs = Number(budget[1]);

    const expected = /^([a-z]+): ([\s\S]*)$/.exec(row['Expected Results']);
    if (!expected) throw new Error(`Cannot read Expected Results "${row['Expected Results']}"`);
    const [, type, raw] = expected;
    let value;
    if (type === 'error') value = raw;
    else if (raw === '(blank)') value = null;
    else value = JSON.parse(raw);

    const confidence = /^Confidence: ([a-z-]+)\./.exec(row['Notes/Comments/Questions'])?.[1] ?? '';
    return {
      id,
      category: categoryOf(id),
      title: row['Name or Test Title'],
      description: row['Description/Summary of Test'],
      formula,
      inputs,
      options,
      expected_type: type,
      expected_value: value,
      confidence,
      row,
    };
  } catch (e) {
    throw new Error(`${id}: ${e.message}`);
  }
};

export const readCaseFile = (text) => parseCsv(text).map(fromRow);
export const writeCaseFile = (rows) => toCsvRows(COLUMNS, rows);
