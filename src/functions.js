// Implementations of Salesforce formula functions. Each `sf$name` receives evaluated literals
// (blank text already turned into '' and, unless the function is listed in NULL_AWARE, never a
// blank number/date) and returns a literal. Evaluation context (clock, prior values, org hooks)
// comes from context.js.

import {
  addDays,
  addMonths,
  buildDateLiteral,
  buildDatetimeLiteral,
  buildGeolocationLiteral,
  buildLiteralFromJs,
  buildTimeLiteral,
  cleanNumber,
  daysDifference,
  formatNumber,
  sfRound,
  utcDate,
} from './utils.js';
import { getContext } from './context.js';
import { fullMatch } from './regex.js';
import EvaluationError from './errors/EvaluationError.js';
import ArgumentError from './errors/ArgumentError.js';
import NotSupportedError from './errors/NotSupportedError.js';

const MS_PER_DAY = 86400000;

// Upper bound for any text value, checked before the text is built, so no formula can allocate
// its way into a hang (nested SUBSTITUTE multiplies length; LPAD can ask for any length).
// 131,072 is Salesforce's largest text field (Long Text Area).
export const MAX_TEXT_LENGTH = 131072;
export const ensureLength = (fn, length) => {
  if (length > MAX_TEXT_LENGTH) {
    throw new EvaluationError(`#Error! ${fn.toUpperCase()}() would produce text longer than ${MAX_TEXT_LENGTH} characters.`, { function: fn });
  }
};
const pad = (n, width = 2) => String(n).padStart(width, '0');

const number = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new EvaluationError('#Error! The result is not a valid number.', {});
  return buildLiteralFromJs(Object.is(n, -0) ? 0 : n);
};
// + - * / results: cut floating-point noise (0.1 + 0.2) back to 15 significant digits.
const decimal = (n) => number(cleanNumber(n));
const bool = (b) => buildLiteralFromJs(Boolean(b));

// Java's String.trim: removes characters up to U+0020 (spaces, tabs, line breaks), not
// non-breaking spaces. A loop rather than /^\s+|\s+$/, which is quadratic on long runs of spaces.
const trimSpaces = (s) => {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 32) start += 1;
  while (end > start && s.charCodeAt(end - 1) <= 32) end -= 1;
  return s.slice(start, end);
};
const text = (s) => {
  ensureLength('text', s.length);
  return buildLiteralFromJs(s);
};
export const blank = (dataType) => ({
  type: 'literal', value: null, dataType, options: {},
});
const notSupported = (fn) => {
  throw new NotSupportedError(`${fn.toUpperCase()}() needs Salesforce org context that was not provided.`, { function: fn });
};
const hook = (name) => {
  const fn = getContext().context?.[name];
  return typeof fn === 'function' ? fn : null;
};
const invalid = (fn, input) => {
  throw new EvaluationError(`#Error! Invalid value '${input}' for ${fn.toUpperCase()}().`, { function: fn, input });
};

// Functions that must see blank (null) arguments themselves instead of returning blank.
export const NULL_AWARE = new Set([
  'isblank', 'isnull', 'blankvalue', 'nullvalue', 'if', 'case', 'and', 'or',
  'equal', 'unequal', 'text', 'ispickval', 'includes', 'picklistcount', 'ischanged', 'priorvalue',
  'hyperlink', 'image', 'isnumber', 'value', 'datevalue', 'datetimevalue', 'timevalue', 'find',
]);

// ---------------------------------------------------------------------------------------------
// Operators

export const sf$equal = (a, b) => {
  if (a.value === null || b.value === null) return bool(a.value === null && b.value === null);
  if (a.value instanceof Date) return bool(a.value.getTime() === b.value.getTime());
  return bool(a.value === b.value);
};

export const sf$unequal = (a, b) => bool(!sf$equal(a, b).value);

const comparable = (v) => (v instanceof Date ? v.getTime() : v);
export const sf$greaterThan = (a, b) => bool(comparable(a.value) > comparable(b.value));
export const sf$greaterThanOrEqual = (a, b) => bool(comparable(a.value) >= comparable(b.value));
export const sf$lessThan = (a, b) => bool(comparable(a.value) < comparable(b.value));
export const sf$lessThanOrEqual = (a, b) => bool(comparable(a.value) <= comparable(b.value));

export const sf$add = (a, b) => {
  switch (`${a.dataType} ${b.dataType}`) {
    case 'number number': return decimal(a.value + b.value);
    case 'text text': return text(a.value + b.value);
    case 'date number': return buildDateLiteral(addDays(a.value, Math.trunc(b.value)));
    case 'number date': return buildDateLiteral(addDays(b.value, Math.trunc(a.value)));
    case 'datetime number': return buildDatetimeLiteral(addDays(a.value, b.value).getTime());
    case 'number datetime': return buildDatetimeLiteral(addDays(b.value, a.value).getTime());
    case 'time number': return buildTimeLiteral(a.value.getTime() + b.value);
    case 'number time': return buildTimeLiteral(b.value.getTime() + a.value);
    default: return ArgumentError.throwWrongType('add', 'Number', b.dataType);
  }
};

export const sf$subtract = (a, b) => {
  switch (`${a.dataType} ${b.dataType}`) {
    case 'number number': return decimal(a.value - b.value);
    case 'date number': return buildDateLiteral(addDays(a.value, -Math.trunc(b.value)));
    case 'datetime number': return buildDatetimeLiteral(addDays(a.value, -b.value).getTime());
    case 'time number': return buildTimeLiteral(a.value.getTime() - b.value);
    case 'date date':
    case 'datetime datetime': return decimal(daysDifference(a.value, b.value));
    // Time subtraction is never negative: 05:00 - 07:00 is 22 hours.
    case 'time time': return number((((a.value.getTime() - b.value.getTime()) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY);
    default: return ArgumentError.throwWrongType('subtract', 'Number', b.dataType);
  }
};

export const sf$multiply = (a, b) => decimal(a.value * b.value);

export const sf$divide = (a, b) => {
  if (b.value === 0) throw new EvaluationError('#Error! Division by zero.', { function: 'divide' });
  return decimal(a.value / b.value);
};

export const sf$exponentiate = (a, b) => decimal(a.value ** b.value);
export const sf$concat = (a, b) => text(a.value + b.value);
export const sf$negate = (a) => number(-a.value);
export const sf$identity = (a) => a;

// ---------------------------------------------------------------------------------------------
// Date and time

// Accepted text forms: date "YYYY-MM-DD", date/time "YYYY-MM-DD HH:MM:SS" (GMT), time
// "HH:MM:SS.MS". No surrounding spaces and no ISO "T...Z" form.
const DATE_TEXT = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const DATETIME_TEXT = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?$/;
const TIME_TEXT = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?$/;

export const sf$addmonths = (date, months) => {
  const result = addMonths(date.value, Math.trunc(months.value));
  return date.dataType === 'datetime' ? buildDatetimeLiteral(result.getTime()) : buildDateLiteral(result);
};

export const sf$date = (year, month, day) => {
  const d = utcDate(Math.trunc(year.value), Math.trunc(month.value), Math.trunc(day.value));
  if (!d) invalid('date', `${year.value}, ${month.value}, ${day.value}`);
  return buildDateLiteral(d);
};

export const sf$datevalue = (value) => {
  if (value.value === null || value.value === '') return blank('date');
  if (value.dataType === 'date') return value;
  if (value.dataType === 'datetime') return buildDateLiteral(value.value);
  const m = DATE_TEXT.exec(value.value) || DATETIME_TEXT.exec(value.value);
  const d = m && utcDate(+m[1], +m[2], +m[3]);
  if (!d) invalid('datevalue', value.value);
  return buildDateLiteral(d);
};

export const sf$datetimevalue = (value) => {
  if (value.value === null || value.value === '') return blank('datetime');
  if (value.dataType === 'datetime') return value;
  if (value.dataType === 'date') return buildDatetimeLiteral(value.value.getTime());
  const m = DATETIME_TEXT.exec(value.value) || DATE_TEXT.exec(value.value);
  const d = m && utcDate(+m[1], +m[2], +m[3]);
  const [h = 0, mi = 0, s = 0] = [m?.[4], m?.[5], m?.[6]].map((x) => (x === undefined ? 0 : +x));
  if (!d || h > 23 || mi > 59 || s > 59) invalid('datetimevalue', value.value);
  const ms = m[7] ? +m[7].padEnd(3, '0') : 0;
  return buildDatetimeLiteral(d.getTime() + ((h * 60 + mi) * 60 + s) * 1000 + ms);
};

export const sf$day = (date) => number(date.value.getUTCDate());
export const sf$month = (date) => number(date.value.getUTCMonth() + 1);
export const sf$year = (date) => number(date.value.getUTCFullYear());
export const sf$weekday = (date) => number(date.value.getUTCDay() + 1);

export const sf$dayofyear = (date) => {
  const start = Date.UTC(date.value.getUTCFullYear(), 0, 1);
  return number(Math.round((date.value.getTime() - start) / MS_PER_DAY) + 1);
};

// ISO 8601: weeks start on Monday; week 1 contains the year's first Thursday.
const isoWeekParts = (d) => {
  const day = d.getUTCDay() || 7;
  const thursday = new Date(d.getTime() + (4 - day) * MS_PER_DAY);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / MS_PER_DAY / 7) + 1;
  return { year, week };
};
export const sf$isoweek = (date) => number(isoWeekParts(date.value).week);
export const sf$isoyear = (date) => number(isoWeekParts(date.value).year);

export const sf$hour = (time) => number(time.value.getUTCHours());
export const sf$minute = (time) => number(time.value.getUTCMinutes());
export const sf$second = (time) => number(time.value.getUTCSeconds());
export const sf$millisecond = (time) => number(time.value.getUTCMilliseconds());

const now = () => getContext().now;
export const sf$now = () => buildDatetimeLiteral(now().getTime());
export const sf$today = () => buildDateLiteral(now());
export const sf$timenow = () => buildTimeLiteral(now().getTime() % MS_PER_DAY);

export const sf$timevalue = (value) => {
  if (value.value === null || value.value === '') return blank('time');
  if (value.dataType === 'time') return value;
  if (value.dataType === 'datetime') return buildTimeLiteral(value.value.getTime() % MS_PER_DAY);
  const m = TIME_TEXT.exec(value.value);
  if (!m) invalid('timevalue', value.value);
  const [h, mi, s = 0] = [+m[1], +m[2], m[3] === undefined ? 0 : +m[3]];
  if (h > 23 || mi > 59 || s > 59) invalid('timevalue', value.value);
  const ms = m[4] ? +m[4].padEnd(3, '0') : 0;
  return buildTimeLiteral(((h * 60 + mi) * 60 + s) * 1000 + ms);
};

export const sf$unixtimestamp = (value) => number(Math.floor(value.value.getTime() / 1000));

export const sf$fromunixtime = (seconds) => buildDatetimeLiteral(Math.trunc(seconds.value * 1000));

// FORMATDURATION(seconds [, include_days]) or (start, end): "HH:MM:SS", or "D:HH:MM:SS".
export const sf$formatduration = (a, b) => {
  let seconds;
  let includeDays = false;
  if (a.dataType === 'number') {
    seconds = a.value;
    includeDays = b ? b.value : false;
  } else {
    seconds = Math.abs(b.value.getTime() - a.value.getTime()) / 1000;
    includeDays = a.dataType === 'datetime';
  }
  if (seconds < 0) invalid('formatduration', seconds);
  let rest = Math.floor(seconds);
  const days = includeDays ? Math.floor(rest / 86400) : 0;
  rest -= days * 86400;
  const hms = `${pad(Math.floor(rest / 3600))}:${pad(Math.floor((rest % 3600) / 60))}:${pad(rest % 60)}`;
  return text(includeDays ? `${days}:${hms}` : hms);
};

// ---------------------------------------------------------------------------------------------
// Logical. IF, CASE, AND, OR, BLANKVALUE and NULLVALUE are evaluated lazily by evaluate.js;
// these versions serve direct calls with already evaluated arguments.

const isBlank = (v) => v.value === null || v.value === '' || (Array.isArray(v.value) && v.value.length === 0);

export const sf$and = (...args) => bool(args.every((a) => a.value === true));
export const sf$or = (...args) => bool(args.some((a) => a.value === true));
export const sf$not = (a) => bool(a.value !== true);
export const sf$if = (test, whenTrue, whenFalse) => (test.value === true ? whenTrue : whenFalse);
export const sf$blankvalue = (value, substitute) => (isBlank(value) ? substitute : value);
export const sf$nullvalue = (value, substitute) => (isBlank(value) ? substitute : value);
export const sf$isblank = (value) => bool(isBlank(value));
export const sf$isnull = (value) => bool(value.dataType !== 'text' && isBlank(value));
export const sf$isnew = () => bool(getContext().isNew === true);
export const sf$isclone = () => bool(getContext().isClone === true);

export const sf$case = (subject, ...rest) => {
  for (let i = 0; i < rest.length - 1; i += 2) {
    if (sf$equal(subject, rest[i]).value) return rest[i + 1];
  }
  return rest[rest.length - 1];
};

// Written so no input can make it backtrack: each part can only match in one way.
const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const isNumberText = (s) => NUMBER_TEXT.test(trimSpaces(s));
// ISNUMBER is strict: any space makes it FALSE (VALUE, by contrast, trims).
export const sf$isnumber = (value) => bool(typeof value.value === 'string' && NUMBER_TEXT.test(value.value));

// ---------------------------------------------------------------------------------------------
// Math

const mathFn = (fn, name) => (x) => {
  const r = fn(x.value);
  if (!Number.isFinite(r)) throw new EvaluationError(`#Error! ${name.toUpperCase()}() is undefined for ${x.value}.`, { function: name });
  return number(r);
};

export const sf$abs = (x) => number(Math.abs(x.value));
// Out of [-1, 1] these return blank, not an error (documented on the function index).
export const sf$acos = (x) => (Math.abs(x.value) > 1 ? blank('number') : number(Math.acos(x.value)));
export const sf$asin = (x) => (Math.abs(x.value) > 1 ? blank('number') : number(Math.asin(x.value)));
export const sf$atan = mathFn(Math.atan, 'atan');
// ATAN2(y, x), as Java's Math.atan2 (the index: "arc tangent of the quotient of y and x").
export const sf$atan2 = (y, x) => number(Math.atan2(y.value, x.value));
export const sf$cos = mathFn(Math.cos, 'cos');
export const sf$sin = mathFn(Math.sin, 'sin');
export const sf$tan = mathFn(Math.tan, 'tan');
export const sf$exp = mathFn(Math.exp, 'exp');
export const sf$ln = mathFn((v) => (v > 0 ? Math.log(v) : NaN), 'ln');
export const sf$log = mathFn((v) => (v > 0 ? Math.log10(v) : NaN), 'log');
export const sf$sqrt = mathFn((v) => (v >= 0 ? Math.sqrt(v) : NaN), 'sqrt');
export const sf$pi = () => number(Math.PI);

// CEILING/FLOOR round away from / toward zero; MCEILING/MFLOOR are the mathematical versions.
export const sf$ceiling = (x) => number(x.value < 0 ? -Math.ceil(-x.value) : Math.ceil(x.value));
export const sf$floor = (x) => number(x.value < 0 ? -Math.floor(-x.value) : Math.floor(x.value));
export const sf$mceiling = (x) => number(Math.ceil(x.value));
export const sf$mfloor = (x) => number(Math.floor(x.value));

export const sf$round = (x, digits) => number(sfRound(x.value, Math.trunc(digits.value)));

export const sf$trunc = (x, digits) => {
  const d = digits ? Math.trunc(digits.value) : 0;
  const factor = 10 ** d;
  return number(Math.trunc(cleanNumber(x.value * factor)) / factor);
};

// Exact for decimals: MOD(0.3, 0.1) is 0, where JS 0.3 % 0.1 gives 0.0999...
const decimals = (n) => {
  const [, frac = '', exp = '0'] = /^-?\d*\.?(\d*)(?:e([+-]?\d+))?$/.exec(String(cleanNumber(n))) ?? [];
  return Math.max(0, frac.length - Number(exp));
};
export const sf$mod = (x, divisor) => {
  if (divisor.value === 0) throw new EvaluationError('#Error! Division by zero.', { function: 'mod' });
  const k = Math.max(decimals(x.value), decimals(divisor.value));
  if (k > 15) return decimal(x.value % divisor.value);
  const f = 10 ** k;
  return decimal((Math.round(x.value * f) % Math.round(divisor.value * f)) / f);
};

const extreme = (pick) => (...args) => {
  const values = args.map((a) => a.value).filter((v) => v !== null);
  if (values.length === 0) return blank('number');
  return number(pick(...values));
};
export const sf$max = extreme(Math.max);
export const sf$min = extreme(Math.min);

export const sf$chr = (code) => {
  const c = code.value;
  const point = Math.trunc(c);
  if (point < 0 || point > 0x10FFFF || (point >= 0xD800 && point <= 0xDFFF)) invalid('chr', c);
  return text(String.fromCodePoint(point));
};

export const sf$picklistcount = (multi) => number(Array.isArray(multi.value) ? multi.value.length : 0);

export const sf$geolocation = (lat, lng) => {
  if (lat.value < -90 || lat.value > 90 || lng.value < -180 || lng.value > 180) invalid('geolocation', `${lat.value}, ${lng.value}`);
  return buildGeolocationLiteral(lat.value, lng.value);
};

// Earth radius reverse engineered from Salesforce: DISTANCE(GEOLOCATION(0,0), GEOLOCATION(0,180), 'km').
const EARTH_RADIUS_KM = 6371.009;
export const sf$distance = (from, to, unit) => {
  const u = unit.value.toLowerCase();
  if (u !== 'km' && u !== 'mi') {
    throw new ArgumentError(`Incorrect parameter value for function 'DISTANCE()'. Expected 'mi'/'km', received '${unit.value}'`, { function: 'distance' });
  }
  const [lat1, lon1] = from.value;
  const [lat2, lon2] = to.value;
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  const km = EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return number(u === 'mi' ? km / 1.609344 : km);
};

// ---------------------------------------------------------------------------------------------
// Text

// Positions and lengths count UTF-16 code units, as Java (and so Salesforce) does: an emoji is 2.
const blankText = () => blank('text');
const blankWhenEmpty = (...args) => args.some((a) => a.value === '');

export const sf$ascii = (t) => (t.value === '' ? blank('number') : number(t.value.codePointAt(0)));
// An empty text on either side is blank, so the test is blank (not TRUE): blank fields pass rules.
export const sf$begins = (t, prefix) => (blankWhenEmpty(t, prefix) ? blank('checkbox') : bool(t.value.startsWith(prefix.value)));
export const sf$contains = (t, search) => (blankWhenEmpty(t, search) ? blank('checkbox') : bool(t.value.includes(search.value)));
export const sf$br = () => text('\n');
// LEN of a blank field is 0: the help's own validation rule checks `LEN(Competitor__c) = 0`.
export const sf$len = (t) => number(t.value.length);
const withLocale = (t, locale, fn) => {
  if (locale && locale.value) {
    try {
      return text(t.value[fn](locale.value.replace('_', '-')));
    } catch {
      // unknown locale: fall back to the default rules
    }
  }
  return text(t.value[fn]());
};
export const sf$lower = (t, locale) => withLocale(t, locale, 'toLocaleLowerCase');
export const sf$upper = (t, locale) => withLocale(t, locale, 'toLocaleUpperCase');
export const sf$reverse = (t) => text(Array.from(t.value).reverse().join(''));
export const sf$trim = (t) => text(trimSpaces(t.value));

// Every word starts upper case; anything that is not a letter or digit separates words.
export const sf$initcap = (t) => text(t.value.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase()));

export const sf$find = (search, t, start) => {
  const from = start && start.value !== null ? Math.trunc(start.value) : 1;
  if (search.value === '' || t.value === '' || from < 1 || from > t.value.length) return number(0);
  return number(t.value.indexOf(search.value, from - 1) + 1);
};

export const sf$mid = (t, start, count) => {
  const from = Math.max(1, Math.trunc(start.value));
  const n = Math.max(0, Math.trunc(count.value));
  return text(t.value.slice(from - 1, from - 1 + n));
};

// A negative count computed at run time counts as 0 (LEFT help page), which the common
// LEFT(Name, FIND(" ", Name) - 1) relies on. A negative literal is rejected in typecheck.js.
export const sf$left = (t, count) => text(t.value.slice(0, Math.max(0, Math.trunc(count.value))));

// A non-integer count gives empty text (observed in a real org by the sformula project).
export const sf$right = (t, count) => {
  if (!Number.isInteger(count.value) || count.value <= 0) return text('');
  return text(t.value.slice(-count.value));
};

const padText = (left) => (t, length, padding) => {
  if (t.value === '' || (padding && padding.value === '')) return blankText();
  const n = Math.max(0, Math.trunc(length.value));
  if (t.value.length >= n) return text(t.value.slice(0, n));
  ensureLength(left ? 'lpad' : 'rpad', n);
  const fill = padding ? padding.value : ' ';
  const filler = fill.repeat(Math.ceil((n - t.value.length) / fill.length)).slice(0, n - t.value.length);
  return text(left ? filler + t.value : t.value + filler);
};
export const sf$lpad = padText(true);
export const sf$rpad = padText(false);

export const sf$substitute = (t, oldText, newText) => {
  if (oldText.value === '') return t;
  const parts = t.value.split(oldText.value);
  ensureLength('substitute', t.value.length + (parts.length - 1) * (newText.value.length - oldText.value.length));
  return text(parts.join(newText.value));
};

// Text that is not a number gives blank (the VALUE help page: "$123" and "EUR123" resolve to blank).
export const sf$value = (t) => {
  if (t.value === null || !isNumberText(t.value)) return blank('number');
  return number(Number(trimSpaces(t.value)));
};

const formatDate = (d) => `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const formatTime = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;

export const sf$text = (v) => {
  // Documented oddity: TEXT() of a blank date/time is "Z".
  if (v.value === null) return text(v.dataType === 'datetime' ? 'Z' : '');
  switch (v.dataType) {
    // Lightning drops the leading zero of decimals: TEXT(0.5) is ".5".
    case 'number': return text((v.options?.source ?? formatNumber(v.value)).replace(/^(-?)0\./, '$1.'));
    case 'date': return text(formatDate(v.value));
    case 'datetime': return text(`${formatDate(v.value)} ${formatTime(v.value).slice(0, 8)}Z`);
    case 'time': return text(formatTime(v.value));
    case 'checkbox': return text(v.value ? 'true' : 'false');
    default: return text(String(v.value));
  }
};

// Only a 15-character id is converted; anything else comes back unchanged.
export const sf$casesafeid = (id) => {
  const s = id.value;
  if (!/^[a-zA-Z0-9]{15}$/.test(s)) return id;
  let suffix = '';
  for (let i = 0; i < 3; i += 1) {
    let flags = 0;
    for (let j = 0; j < 5; j += 1) {
      const c = s[i * 5 + j];
      if (c >= 'A' && c <= 'Z') flags += 2 ** j;
    }
    suffix += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'[flags];
  }
  return text(s + suffix);
};

export const sf$ispickval = (picklist, value) => bool((picklist.value ?? '') === (value.value ?? ''));

export const sf$includes = (multi, value) => bool(Array.isArray(multi.value) && multi.value.includes(value.value));

// Blank text renders as a single space; with no target Salesforce generates target="_blank".
const orSpace = (v) => (v === null || v === undefined || v === '' ? ' ' : v);
export const sf$hyperlink = (url, label, target) => ({
  type: 'literal',
  dataType: 'hyperlink',
  // label is text, or an image object when the link wraps IMAGE(...)
  value: {
    url: orSpace(url.value),
    label: label.dataType === 'image' ? label.value : orSpace(label.value),
    target: target && target.value ? target.value : '_blank',
  },
  options: {},
});

// A blank height or width is 0; an omitted one is null.
export const sf$image = (url, alt, height, width) => ({
  type: 'literal',
  dataType: 'image',
  value: {
    url: orSpace(url.value),
    alt: orSpace(alt.value),
    height: height ? (height.value ?? 0) : null,
    width: width ? (width.value ?? 0) : null,
  },
  options: {},
});

const HTML_ESCAPES = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
const JS_ESCAPES = {
  '\\': '\\\\', "'": "\\'", '"': '\\"', '/': '\\/', '<': '\\u003C', '>': '\\u003E', '\n': '\\n', '\r': '\\r', '\t': '\\t',
};
const htmlEncode = (s) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
const jsEncode = (s, pattern = /[\\'"/<>\n\r\t]/g) => s.replace(pattern, (c) => JS_ESCAPES[c]);
export const sf$htmlencode = (t) => text(htmlEncode(t.value));
export const sf$jsencode = (t) => text(jsEncode(t.value));
// HTML-encode first, then JS-escape what HTML encoding leaves (the help page's definition and its
// example output, which keeps '/' as is).
export const sf$jsinhtmlencode = (t) => text(jsEncode(htmlEncode(t.value), /[\\\n\r\t]/g));
export const sf$urlencode = (t) => text(encodeURIComponent(t.value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`));

export const sf$getsessionid = () => {
  const { sessionId } = getContext().context ?? {};
  return sessionId ? text(sessionId) : notSupported('getsessionid');
};

// ---------------------------------------------------------------------------------------------
// Advanced

export const sf$regex = (t, pattern) => bool(fullMatch(t.value, pattern.value));

export const sf$currencyrate = (iso) => {
  const lookup = hook('currencyRate');
  if (!lookup) return notSupported('currencyrate');
  const rate = lookup(iso.value);
  if (typeof rate !== 'number') invalid('currencyrate', iso.value);
  return number(rate);
};

// Functions that only make sense inside a live org (buttons, Visualforce, reports, Einstein).
// They work when the host passes an implementation in options.context, and otherwise report
// NotSupportedError rather than inventing a value.
const hosted = (fn) => (...args) => {
  const impl = hook(fn);
  return impl ? impl(...args) : notSupported(fn);
};
export const sf$vlookup = hosted('vlookup');
export const sf$getrecordids = hosted('getrecordids');
// The one advanced function with a fixed, data-free output.
export const sf$requirescript = (url) => text(`<script src="${url.value.replace(/"/g, '&quot;')}"></script>`);
export const sf$imageproxyurl = hosted('imageproxyurl');
export const sf$include = hosted('include');
export const sf$junctionidlist = hosted('junctionidlist');
export const sf$linkto = hosted('linkto');
export const sf$predict = hosted('predict');
export const sf$urlfor = hosted('urlfor');
export const sf$parentgroupval = hosted('parentgroupval');
export const sf$prevgroupval = hosted('prevgroupval');
