// compile() and evaluate(): parse once, type-check against the record's field types, then
// evaluate lazily. Never throws — every problem comes back as { type: 'error', errorType, message }.

import { parseFormula } from './parser.js';
import { typecheck, typeName, typeCode } from './typecheck.js';
import { withContext } from './context.js';
import * as functions from './functions.js';
import { NULL_AWARE, blank } from './functions.js';
import FormulonRuntimeError from './errors/FormulonRuntimeError.js';
import ArgumentError from './errors/ArgumentError.js';
import ReturnTypeError from './errors/ReturnTypeError.js';
import SyntaxErrorClass from './errors/SyntaxError.js';
import { buildErrorLiteral, sfRound, utcDate } from './utils.js';

export const MAX_FORMULA_LENGTH = 100000;

// ---------------------------------------------------------------------------------------------
// Inputs: { FieldName: { type, value } } — `type` may be a Salesforce field type name. Formulon's
// older { type: 'literal', dataType, value, options } shape is accepted too.

const TYPE_ALIASES = {
  number: 'number',
  currency: 'number',
  percent: 'number',
  double: 'number',
  integer: 'number',
  int: 'number',
  long: 'number',
  text: 'text',
  string: 'text',
  textarea: 'text',
  email: 'text',
  phone: 'text',
  url: 'text',
  id: 'text',
  reference: 'text',
  encryptedstring: 'text',
  checkbox: 'checkbox',
  boolean: 'checkbox',
  date: 'date',
  datetime: 'datetime',
  time: 'time',
  picklist: 'picklist',
  multipicklist: 'multipicklist',
  geolocation: 'geolocation',
  location: 'geolocation',
  null: 'null',
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z?$/;

const badInput = (name, why) => {
  throw new ArgumentError(`Invalid value for field ${name}: ${why}.`, { identifier: name });
};

const toDate = (name, v, dateOnly) => {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) badInput(name, 'invalid date');
    return dateOnly ? new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate())) : v;
  }
  if (typeof v === 'number') return toDate(name, new Date(v), dateOnly);
  if (typeof v === 'string') {
    const m = DATE_ONLY.exec(v);
    if (m) {
      const d = utcDate(+m[1], +m[2], +m[3]);
      if (!d) badInput(name, `'${v}' is not a date`);
      return d;
    }
    const parsed = new Date(v);
    if (Number.isNaN(parsed.getTime())) badInput(name, `'${v}' is not a date`);
    return toDate(name, parsed, dateOnly);
  }
  return badInput(name, 'expected a date');
};

const toTime = (name, v) => {
  if (v instanceof Date) return new Date(v.getTime() % 86400000);
  if (typeof v === 'number') return new Date(((v % 86400000) + 86400000) % 86400000);
  const m = typeof v === 'string' && TIME_ONLY.exec(v);
  if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] ?? 0) > 59) return badInput(name, `'${v}' is not a time`);
  return new Date(((+m[1] * 60 + +m[2]) * 60 + +(m[3] ?? 0)) * 1000 + +(m[4] ?? '0').padEnd(3, '0'));
};

const bindInput = (name, spec, blankAs) => {
  if (spec === null || typeof spec !== 'object') badInput(name, 'expected { type, value }');
  const declared = spec.type === 'literal' ? spec.dataType : (spec.dataType ?? spec.type);
  const dataType = TYPE_ALIASES[String(declared).toLowerCase()];
  if (!dataType) badInput(name, `unknown type '${declared}'`);
  let { value } = spec;
  if (value === undefined || (typeof value === 'number' && Number.isNaN(value))) value = null;

  const literal = (v) => ({
    type: 'literal', dataType, value: v, options: spec.options ?? {},
  });

  switch (dataType) {
    case 'number':
      if (value === null) return literal(blankAs === 'zero' ? 0 : null);
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return literal(Number(value));
      if (typeof value !== 'number' || !Number.isFinite(value)) badInput(name, 'expected a number');
      return literal(value);
    case 'text':
      if (value === null) return literal('');
      return literal(String(value));
    case 'checkbox':
      return literal(value === true || value === 'true');
    case 'date':
    case 'datetime':
      return literal(value === null || value === '' ? null : toDate(name, value, dataType === 'date'));
    case 'time':
      return literal(value === null || value === '' ? null : toTime(name, value));
    case 'picklist':
      return literal(value === null || value === '' ? null : String(value));
    case 'multipicklist': {
      if (value === null || value === '') return literal(null);
      const list = Array.isArray(value) ? value.map(String) : String(value).split(';');
      return literal(list.length ? list : null);
    }
    case 'geolocation': {
      if (value === null) return literal(null);
      const pair = Array.isArray(value) ? value : [value.latitude, value.longitude];
      if (pair.length !== 2 || !pair.every((n) => typeof n === 'number' && Number.isFinite(n))) badInput(name, 'expected [latitude, longitude]');
      return literal(pair);
    }
    default:
      return literal(null);
  }
};

const bindAll = (inputs, blankAs) => {
  const env = new Map();
  Object.entries(inputs ?? {}).forEach(([name, spec]) => {
    env.set(name.toLowerCase(), bindInput(name, spec, blankAs));
  });
  return env;
};

// ---------------------------------------------------------------------------------------------
// Evaluation

const TEXT_BLANK = { type: 'literal', dataType: 'text', value: '', options: { length: 0 } };
const checkbox = (value) => ({
  type: 'literal', dataType: 'checkbox', value, options: {},
});

const expandParams = (params, count) => Array.from(
  { length: count },
  (_, i) => params[Math.min(i, params.length - 1)],
);

// HYPERLINK/IMAGE results used as text (for example inside `&`) become escaped HTML, which is
// what Salesforce's text form of them is.
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const toHtml = (arg) => {
  const v = arg.value;
  if (arg.dataType === 'html') return v;
  if (arg.dataType === 'text') return escapeHtml(v);
  if (arg.dataType === 'hyperlink') {
    const label = v.label && typeof v.label === 'object' ? toHtml({ dataType: 'image', value: v.label }) : escapeHtml(v.label);
    return `<a href="${escapeHtml(v.url)}"${v.target ? ` target="${escapeHtml(v.target)}"` : ''}>${label}</a>`;
  }
  return `<img src="${escapeHtml(v.url)}" alt="${escapeHtml(v.alt)}"${v.height != null ? ` height="${escapeHtml(v.height)}"` : ''}${v.width != null ? ` width="${escapeHtml(v.width)}"` : ''} border="0"/>`;
};
const RICH = new Set(['hyperlink', 'image', 'html']);

const invoke = (fn, args, annotation) => {
  if (annotation.ret === 'R') {
    // Text joined with links/images: escape the text, keep the generated tags.
    const html = args.map((a) => (a.value === null ? '' : toHtml(a))).join('');
    functions.ensureLength('concat', html.length);
    return {
      type: 'literal', dataType: 'html', value: html, options: {},
    };
  }
  const params = expandParams(annotation.params ?? [], args.length);
  const ready = new Array(args.length);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.value === null || arg.value === undefined) {
      if (params[i]?.type === 'T') {
        ready[i] = TEXT_BLANK;
      } else if (NULL_AWARE.has(fn)) {
        ready[i] = arg;
      } else {
        return blank(typeName(annotation.ret) ?? 'null');
      }
    } else if (fn === 'hyperlink' && i === 1 && arg.dataType === 'image') {
      ready[i] = arg; // a clickable image: HYPERLINK(url, IMAGE(...))
    } else if (params[i]?.type === 'T' && RICH.has(arg.dataType)) {
      // LEFT(HYPERLINK(...), 5) and the like: #Error! in Salesforce.
      throw new FormulonRuntimeError(`#Error! ${fn.toUpperCase()}() cannot take a hyperlink or image.`, 'RuntimeError', { function: fn });
    } else {
      ready[i] = arg;
    }
  }
  return functions[`sf$${fn}`](...ready);
};

const isBlank = (v) => v.value === null || v.value === '' || (Array.isArray(v.value) && v.value.length === 0);

const sameValue = (a, b) => {
  const x = a?.value ?? null;
  const y = b?.value ?? null;
  if (x instanceof Date && y instanceof Date) return x.getTime() === y.getTime();
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => v === y[i]);
  return x === y || ((x === '' || x === null) && (y === '' || y === null));
};

const makeEvaluator = (env, prior, isNew, annotations) => {
  const evalNode = (node) => {
    switch (node.type) {
      case 'literal': return node;
      case 'identifier': return env.get(node.name.toLowerCase());
      default: break;
    }

    const fn = node.id;
    const args = node.arguments;
    switch (fn) {
      case 'if':
        return evalNode(evalNode(args[0]).value === true ? args[1] : args[2]);
      case 'case': {
        // Not lazy: "CASE returns an error if any of its expressions return an error, regardless
        // of which one should be returned" (CASE help page). IF is lazy.
        const values = args.map(evalNode);
        for (let i = 1; i < values.length - 1; i += 2) {
          if (functions.sf$equal(values[0], values[i]).value) return values[i + 1];
        }
        return values[values.length - 1];
      }
      case 'and':
        return checkbox(args.every((a) => evalNode(a).value === true));
      case 'or':
        return checkbox(args.some((a) => evalNode(a).value === true));
      case 'blankvalue': {
        const value = evalNode(args[0]);
        return isBlank(value) ? evalNode(args[1]) : value;
      }
      case 'nullvalue': {
        // Text is never null, so NULLVALUE returns blank text as it is.
        const value = evalNode(args[0]);
        return value.dataType !== 'text' && isBlank(value) ? evalNode(args[1]) : value;
      }
      case '$params':
        return {
          type: 'literal', dataType: 'params', value: args.map(evalNode), options: {},
        };
      case 'ischanged': {
        const name = args[0].name.toLowerCase();
        return checkbox(!isNew && prior.has(name) && !sameValue(prior.get(name), env.get(name)));
      }
      case 'priorvalue': {
        const name = args[0].name.toLowerCase();
        return !isNew && prior.has(name) ? prior.get(name) : env.get(name);
      }
      default:
        return invoke(fn, args.map(evalNode), annotations.get(node));
    }
  };
  return evalNode;
};

const RETURN_TYPES = {
  number: 'number',
  currency: 'number',
  percent: 'number',
  text: 'text',
  checkbox: 'checkbox',
  date: 'date',
  datetime: 'datetime',
  time: 'time',
};

const finish = (result, options) => {
  let out = result;
  if (out.dataType === 'checkbox' && out.value === null) out = { ...out, value: false };
  if (out.dataType === 'null') out = { ...out, value: null };
  // "The output of your formula must be less than 19 digits", otherwise Salesforce shows #Too Big!
  if (out.dataType === 'number' && out.value !== null && Math.abs(out.value) >= 1e18) {
    throw new FormulonRuntimeError('#Too Big! The result has more than 18 digits.', 'RuntimeError', {});
  }
  if (options.returnType) {
    const wanted = RETURN_TYPES[String(options.returnType).toLowerCase()];
    if (!wanted) throw new ReturnTypeError(`Unknown return type '${options.returnType}'.`, {});
    const actual = out.dataType === 'hyperlink' || out.dataType === 'image' ? 'text' : out.dataType;
    if (actual !== 'null' && actual !== wanted) {
      throw new ReturnTypeError(`Formula result is data type (${actual}), incompatible with expected data type (${wanted}).`, { expected: wanted, received: actual });
    }
    if (wanted === 'number' && out.value !== null && Number.isInteger(options.scale)) {
      out = { ...out, value: sfRound(out.value, options.scale) };
    }
    if (actual === 'null') out = { ...out, dataType: wanted };
  }
  return out;
};

const toError = (err) => {
  if (err instanceof FormulonRuntimeError) return buildErrorLiteral(err.errorType, err.message, err.options);
  if (err instanceof RangeError) return buildErrorLiteral('RuntimeError', '#Error! The formula is too complex to evaluate.', {});
  return buildErrorLiteral('InternalError', `Internal error: ${err && err.message}`, {});
};

const extractReferences = (ast) => {
  const names = [];
  const seen = new Set();
  const visit = (n) => {
    if (n.type === 'identifier' && !seen.has(n.name)) {
      seen.add(n.name);
      names.push(n.name);
    } else if (n.type === 'callExpression') {
      n.arguments.forEach(visit);
    }
  };
  visit(ast);
  return names;
};

const containsNull = (n) => (n.type === 'literal' && n.dataType === 'null')
  || (n.type === 'callExpression' && n.arguments.some(containsNull));

// Type-check and evaluate a parsed formula.
export const evaluateAst = (ast, inputs = {}, options = {}) => {
  try {
    const blankAs = options.blankAs === 'zero' ? 'zero' : 'blank';
    const env = bindAll(inputs, blankAs);
    const prior = bindAll(options.prior, blankAs);
    const annotations = new Map();
    const rootType = typecheck(ast, (name) => {
      const bound = env.get(name.toLowerCase());
      return bound && typeCode(bound.dataType);
    }, annotations);

    const now = options.now ? new Date(options.now) : null;
    if (now && Number.isNaN(now.getTime())) throw new ArgumentError(`Invalid option now: '${options.now}'.`, {});
    const ctx = {
      now,
      isNew: options.isNew === true,
      isClone: options.isClone === true,
      blankAs,
      context: options.context ?? {},
    };
    if (rootType === 'P' || rootType === 'MP') {
      throw new ArgumentError('A picklist field can only be used in ISPICKVAL(), CASE(), TEXT() or ISBLANK().', {});
    }
    if (String(options.returnType).toLowerCase() === 'checkbox' && containsNull(ast)) {
      throw new ReturnTypeError('NULL is not supported in a checkbox formula.', {});
    }
    const evalNode = makeEvaluator(env, prior, ctx.isNew, annotations);
    return finish(withContext(ctx, () => evalNode(ast)), options);
  } catch (err) {
    return toError(err);
  }
};

// Parse once; evaluate many times against different records.
export const compile = (formula) => {
  let ast = null;
  let parseError = null;
  try {
    if (typeof formula !== 'string') throw new SyntaxErrorClass('Syntax error. The formula must be text.', {});
    if (formula.length > MAX_FORMULA_LENGTH) throw new SyntaxErrorClass(`Syntax error. The formula is longer than ${MAX_FORMULA_LENGTH} characters.`, {});
    ast = parseFormula(formula);
  } catch (err) {
    parseError = toError(err);
  }

  const references = ast ? extractReferences(ast) : [];

  const run = (inputs = {}, options = {}) => (parseError || evaluateAst(ast, inputs, options));

  return { ast, references, error: parseError, evaluate: run };
};

const compiledCache = new Map();
const MAX_CACHE = 500;

export const evaluate = (formula, inputs, options) => {
  let compiled = compiledCache.get(formula);
  if (!compiled) {
    compiled = compile(formula);
    if (compiledCache.size >= MAX_CACHE) compiledCache.delete(compiledCache.keys().next().value);
    compiledCache.set(formula, compiled);
  }
  return compiled.evaluate(inputs, options);
};
