// Parameter and return types of every Salesforce formula function and operator.
//
// Notation, one string per function, overloads separated by `|`:
//   'N,N?:N'   two parameters, the second optional, returns N
//   'B...:B'   one or more B
//   'X,X:X'    X is a type variable: all X must be the same type (NULL fits any)
// Type codes:
//   N number  T text  B checkbox  D date  DT datetime  TM time  P picklist  MP multi-select picklist
//   G geolocation  H hyperlink  I image  R html (text joined with links/images)  A any type  S any scalar that can be compared (N T B D DT TM)
// A function marked in SPECIAL is checked by its own rule in typecheck.js.

export const TYPE_NAMES = {
  N: 'number',
  T: 'text',
  B: 'checkbox',
  D: 'date',
  DT: 'datetime',
  TM: 'time',
  P: 'picklist',
  MP: 'multipicklist',
  G: 'geolocation',
  H: 'hyperlink',
  I: 'image',
  R: 'html',
};

export const SIGNATURES = {
  // Operators (the parser turns `a + b` into add(a, b), and so on)
  add: 'N,N:N|T,T:T|D,N:D|N,D:D|DT,N:DT|N,DT:DT|TM,N:TM|N,TM:TM',
  subtract: 'N,N:N|D,N:D|DT,N:DT|TM,N:TM|D,D:N|DT,DT:N|TM,TM:N',
  multiply: 'N,N:N',
  divide: 'N,N:N',
  exponentiate: 'N,N:N',
  concat: 'T,T:T',
  negate: 'N:N',
  identity: 'N:N',
  equal: 'X,X:B',
  unequal: 'X,X:B',
  lessThan: 'X,X:B',
  lessThanOrEqual: 'X,X:B',
  greaterThan: 'X,X:B',
  greaterThanOrEqual: 'X,X:B',

  // Date and time
  addmonths: 'D,N:D|DT,N:DT',
  date: 'N,N,N:D',
  datevalue: 'T:D|DT:D',
  datetimevalue: 'T:DT|D:DT|DT:DT',
  day: 'D:N',
  dayofyear: 'D:N',
  formatduration: 'N,B?:T|DT,DT:T|TM,TM:T',
  hour: 'TM:N',
  isoweek: 'D:N',
  isoyear: 'D:N',
  millisecond: 'TM:N',
  minute: 'TM:N',
  month: 'D:N',
  now: ':DT',
  second: 'TM:N',
  timenow: ':TM',
  timevalue: 'T:TM|DT:TM|TM:TM',
  today: ':D',
  unixtimestamp: 'D:N|DT:N|TM:N',
  weekday: 'D:N',
  year: 'D:N',

  // Logical
  and: 'B...:B',
  blankvalue: 'X,X:X',
  case: null,
  if: 'B,X,X:X',
  isblank: 'A:B',
  isclone: ':B',
  isnew: ':B',
  isnull: 'A:B',
  isnumber: 'T:B',
  not: 'B:B',
  nullvalue: 'X,X:X',
  or: 'B...:B',
  priorvalue: null,
  ischanged: null,

  // Math
  abs: 'N:N',
  acos: 'N:N',
  asin: 'N:N',
  atan: 'N:N',
  atan2: 'N,N:N',
  ceiling: 'N:N',
  chr: 'N:T',
  cos: 'N:N',
  distance: 'G,G,T:N',
  exp: 'N:N',
  floor: 'N:N',
  fromunixtime: 'N:DT',
  geolocation: 'N,N:G',
  ln: 'N:N',
  log: 'N:N',
  max: 'N...:N',
  mceiling: 'N:N',
  mfloor: 'N:N',
  min: 'N...:N',
  mod: 'N,N:N',
  pi: ':N',
  picklistcount: 'MP:N',
  round: 'N,N:N',
  sin: 'N:N',
  sqrt: 'N:N',
  tan: 'N:N',
  trunc: 'N,N?:N',

  // Text
  ascii: 'T:N',
  begins: 'T,T:B',
  br: ':T',
  casesafeid: 'T:T',
  contains: 'T,T:B',
  find: 'T,T,N?:N',
  getsessionid: ':T',
  htmlencode: 'T:T',
  hyperlink: 'T,T,T?:H',
  image: 'T,T,N?,N?:I',
  includes: 'MP,T:B',
  initcap: 'T:T',
  ispickval: 'P,T:B',
  jsencode: 'T:T',
  jsinhtmlencode: 'T:T',
  left: 'T,N:T',
  len: 'T:N',
  lower: 'T,T?:T',
  lpad: 'T,N,T?:T',
  mid: 'T,N,N:T',
  reverse: 'T:T',
  right: 'T,N:T',
  rpad: 'T,N,T?:T',
  substitute: 'T,T,T:T',
  text: 'N:T|D:T|DT:T|TM:T|P:T',
  trim: 'T:T',
  upper: 'T,T?:T',
  urlencode: 'T:T',
  value: 'T:N',

  // Advanced. Most take org metadata references ($ObjectType..., $Action...) and need live org
  // context; see HOSTED in typecheck.js.
  currencyrate: 'T:N',
  getrecordids: 'A:T',
  imageproxyurl: 'A:T',
  include: 'A,A?:T',
  junctionidlist: 'A...:T',
  linkto: 'A,A,A?,A?,A?:T',
  predict: 'A,A...:T',
  regex: 'T,T:B',
  requirescript: 'T:T',
  urlfor: 'A,A?,A?,A?:T',
  vlookup: 'A,A,A:X',

  // Summary (report custom summary formulas only)
  parentgroupval: 'A,A,A?:N',
  prevgroupval: 'A,A,A?:N',
};

// Parsed form: { [name]: [{ params: [{type, optional, variadic}], ret }] }
const parseOverload = (text) => {
  const [paramText, ret] = text.split(':');
  const params = paramText === '' ? [] : paramText.split(',').map((p) => ({
    type: p.replace(/\?|\.\.\./g, ''),
    optional: p.endsWith('?'),
    variadic: p.endsWith('...'),
  }));
  return { params, ret };
};

export const OVERLOADS = Object.fromEntries(
  Object.entries(SIGNATURES).map(([name, text]) => [name, text && text.split('|').map(parseOverload)]),
);

export const arity = (name) => {
  const overloads = OVERLOADS[name];
  if (!overloads) return null;
  let min = Infinity;
  let max = 0;
  overloads.forEach(({ params }) => {
    min = Math.min(min, params.filter((p) => !p.optional).length);
    max = Math.max(max, params.some((p) => p.variadic) ? Infinity : params.length);
  });
  return { min, max };
};
