// Minimal RFC 4180 CSV reader/writer for the formula case file. No dependency on purpose.

export const COLUMNS = [
  'id', 'category', 'function', 'description', 'formula', 'inputs', 'options',
  'expected_type', 'expected_value', 'source', 'confidence',
];

export const parseCsv = (input) => {
  const text = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.length > 1 || r[0] !== '');
  return body.map((r) => Object.fromEntries(header.map((name, index) => [name, r[index] ?? ''])));
};

const quote = (value) => {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
};

// With a byte-order mark so Excel opens the file as UTF-8.
export const toCsvRows = (columns, records) => `\uFEFF${[
  columns.map(quote).join(','),
  ...records.map((r) => columns.map((c) => quote(r[c])).join(',')),
].join('\r\n')}\r\n`;

export const toCsv = (records) => [
  COLUMNS.join(','),
  ...records.map((r) => COLUMNS.map((c) => quote(r[c])).join(',')),
].join('\n').concat('\n');
