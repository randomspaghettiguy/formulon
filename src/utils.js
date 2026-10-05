import FormulonRuntimeError from './errors/FormulonRuntimeError.js';

const MILLISECONDS_IN_DAY = 24 * 60 * 60 * 1000;

// Arithmetic on doubles leaves noise past the 15th significant digit (0.1 + 0.2 =
// 0.30000000000000004). Salesforce computes in decimal, so results are cut back to 15 digits.
export const cleanNumber = (n) => {
  if (!Number.isFinite(n)) return n;
  const cleaned = parseFloat(n.toPrecision(15));
  return Object.is(cleaned, -0) ? 0 : cleaned;
};

// Salesforce rounds half away from zero: ROUND(-1.5, 0) = -2, where JS Math.round gives -1.
export const sfRound = (number, numDigits) => {
  if (number < 0) return -sfRound(-number, numDigits);
  const factor = 10 ** numDigits;
  return cleanNumber(Math.round(cleanNumber(number * factor)) / factor);
};

// Plain decimal notation, never exponent notation: 1e21 -> "1000000000000000000000".
export const formatNumber = (n) => (Math.abs(n) >= 1e21 || (n !== 0 && Math.abs(n) < 1e-6)
  ? n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
  : String(n));

// A UTC midnight date, or null when the parts are not a real calendar date. Formulas accept the
// years -4713 to 9999 ("Tips for Using Date and Date/Time Formulas"); fields store 1700-4000.
export const utcDate = (year, month, day) => {
  if (![year, month, day].every(Number.isInteger)) return null;
  if (year < -4713 || year > 9999 || year === 0 || month < 1 || month > 12 || day < 1) return null;
  const d = new Date(Date.UTC(2000, month - 1, day));
  d.setUTCFullYear(year);
  return d.getUTCDate() === day && d.getUTCMonth() === month - 1 ? d : null;
};

// private

const calculateNumberOptions = (number) => {
  const numberString = (number).toString().replace('-', '');
  if (numberString.indexOf('.') !== -1) {
    const splitted = numberString.split('.');
    return {
      length: splitted[0].length,
      scale: splitted[1].length,
    };
  }

  return {
    length: numberString.length,
    scale: 0,
  };
};

const coerceValue = (dataType, value, options) => {
  switch (dataType) {
    case 'number':
      return sfRound(value, options.scale);
    case 'text':
      return value.substring(0, options.length);
    default:
      return value;
  }
};

const geolocationFormat = (latitude, longitude) => {
  if ((!latitude || !longitude) && (latitude !== 0 && longitude !== 0)) return '';

  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
};

// public

export const buildLiteralFromJs = (input) => {
  const base = { type: 'literal', value: input };

  if (input === null || input === undefined) {
    return Object.assign(
      base,
      { value: null, dataType: 'null', options: {} },
    );
  }

  const type = typeof (input);
  switch (typeof (input)) {
    case 'number':
      return Object.assign(
        base,
        { dataType: 'number', options: calculateNumberOptions(input) },
      );
    case 'string':
      return Object.assign(
        base,
        { dataType: 'text', options: { length: input.length } },
      );
    case 'boolean':
      return Object.assign(
        base,
        { dataType: 'checkbox', options: {} },
      );
    default:
      throw new TypeError(`Unsupported type '${type}'`);
  }
};

export const buildErrorLiteral = (errorType, message, options) => ({
  type: 'error',
  errorType,
  message,
  ...options,
});

const MIN_TIME = new Date(Date.UTC(2000, 0, 1)).setUTCFullYear(-4713);
const MAX_TIME = Date.UTC(10000, 0, 1) - 1;
const checkRange = (time) => {
  if (!(time >= MIN_TIME && time <= MAX_TIME)) {
    throw new FormulonRuntimeError('#Error! The date is outside the supported range (-4713 to 9999).', 'RuntimeError', {});
  }
};

export const buildDateLiteral = (yearOrDateObj, month, day) => {
  if (yearOrDateObj instanceof Date) {
    return buildDateLiteral(
      yearOrDateObj.getUTCFullYear(),
      yearOrDateObj.getUTCMonth() + 1,
      yearOrDateObj.getUTCDate(),
    );
  }

  const value = new Date(Date.UTC(2000, month - 1, day));
  value.setUTCFullYear(yearOrDateObj);
  checkRange(value.getTime());
  return {
    type: 'literal',
    dataType: 'date',
    value,
    options: {},
  };
};

export const buildDatetimeLiteral = (unixTimestamp) => {
  checkRange(unixTimestamp);
  return {
    type: 'literal',
    dataType: 'datetime',
    value: new Date(unixTimestamp),
    options: {},
  };
};

export const buildGeolocationLiteral = (latitude, longitude) => ({
  type: 'literal',
  dataType: 'geolocation',
  value: [latitude, longitude],
  options: {},
});

export const buildPicklistLiteral = (value, values) => ({
  type: 'literal',
  dataType: 'picklist',
  value,
  options: { values },
});

export const buildMultipicklistLiteral = (value, values) => ({
  type: 'literal',
  dataType: 'multipicklist',
  value,
  options: { values },
});

// Time wraps around midnight: 23:00 + 2 hours is 01:00.
export const buildTimeLiteral = (millisecondsFromMidnight) => ({
  type: 'literal',
  dataType: 'time',
  value: new Date(((millisecondsFromMidnight % 86400000) + 86400000) % 86400000),
  options: {},
});

export const arrayUnique = (array) => array.reduce((p, c) => {
  if (p.indexOf(c) < 0) p.push(c);
  return p;
}, []);

export const coerceLiteral = (input) => {
  if (input.value === undefined || input.value === null || Number.isNaN(input.value)) {
    return {
      type: 'literal',
      value: null,
      dataType: 'null',
      options: {},
    };
  }

  return {
    ...input,
    value: coerceValue(input.dataType, input.value, input.options),
  };
};

export const handleFormulonError = (fn) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof FormulonRuntimeError) {
      return buildErrorLiteral(err.errorType, err.message, err.options);
    }

    throw err;
  }
};

// ADDMONTHS: the same day in the target month, clamped to that month's length. A date on the last
// day of its month moves to the last day of the target month.
export const addMonths = (date, numOfMonths) => {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const timeOfDay = date.getTime() - Date.UTC(y, m, d);
  const lastOfSource = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const lastOfTarget = new Date(Date.UTC(y, m + numOfMonths + 1, 0)).getUTCDate();
  const day = d === lastOfSource ? lastOfTarget : Math.min(d, lastOfTarget);
  return new Date(Date.UTC(y, m + numOfMonths, day) + timeOfDay);
};

export const addDays = (date, numOfDays) => (
  new Date(date.getTime() + numOfDays * MILLISECONDS_IN_DAY)
);

export const daysDifference = (date1, date2) => (
  (date1.getTime() - date2.getTime()) / MILLISECONDS_IN_DAY
);

export const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string

export const formatLiteral = (literal) => {
  if (!literal.value && literal.dataType !== 'null' && literal.value !== 0 && literal.value !== false && literal.value !== '') return '';

  switch (literal.dataType) {
    case 'null':
      return 'NULL';
    case 'number':
      return literal.value.toString();
    case 'text':
    case 'picklist':
      return `"${literal.value}"`;
    case 'multipicklist':
      return `[${literal.value.map((value) => `"${value}"`).join(', ')}]`;
    case 'checkbox':
      return literal.value.toString().toUpperCase();
    case 'date':
      return `${literal.value.getUTCFullYear()}-${(literal.value.getUTCMonth() + 1).toString().padStart(2, '0')}-${literal.value.getUTCDate().toString().padStart(2, '0')}`;
    case 'datetime':
      return literal.value.toISOString();
    case 'time':
      return literal.value.toISOString().split('T')[1].replace('Z', '');
    case 'geolocation':
      return geolocationFormat(literal.value[0], literal.value[1]);
    default:
      return undefined;
  }
};
