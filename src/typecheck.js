// Static type check, run before evaluation. Salesforce checks types when a formula is saved, so
// `IF(TRUE, 1, "a")` is an error even though the "a" branch can never be taken. Running the same
// check here also lets the evaluator skip branches it does not need (lazy IF/CASE/AND/OR).

import { OVERLOADS, TYPE_NAMES, arity } from './signatures.js';
import ArgumentError from './errors/ArgumentError.js';
import NoFunctionError from './errors/NoFunctionError.js';
import ReferenceError from './errors/ReferenceError.js';
import NotSupportedError from './errors/NotSupportedError.js';
import EvaluationError from './errors/EvaluationError.js';

const CODES = Object.fromEntries(Object.entries(TYPE_NAMES).map(([code, name]) => [name, code]));
CODES.null = 'NULL';

// Types a type variable X may stand for. Picklists, multi-select picklists and geolocations can
// only be used through the functions made for them.
const GENERIC = new Set(['N', 'T', 'B', 'D', 'DT', 'TM', 'H', 'I', 'R']);
const RICH = new Set(['H', 'I', 'R']);
// < > <= >= work on numbers, dates and times; text has no ordering in formulas.
const ORDERED = new Set(['N', 'D', 'DT', 'TM']);
// Functions whose arguments are org metadata references rather than values.
const HOSTED = new Set(['getrecordids', 'imageproxyurl', 'include', 'junctionidlist', 'linkto', 'predict', 'urlfor', 'vlookup', 'parentgroupval', 'prevgroupval']);
const COMPARISONS = new Set(['lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual']);
const COMPARISON_IDS = new Set([...COMPARISONS, 'equal', 'unequal']);

export const typeName = (code) => (code === 'NULL' ? 'null' : TYPE_NAMES[code]);
export const typeCode = (name) => CODES[name];

const label = (code) => {
  const name = typeName(code) || code;
  return name.charAt(0).toUpperCase() + name.slice(1);
};

const wrongType = (fn, expected, received) => ArgumentError.throwWrongType(fn, label(expected), label(received));

// Text, link and image results may meet in IF/CASE branches: IF(x, HYPERLINK(...), "none").
const TEXTUAL = new Set(['T', 'H', 'I', 'R']);
const unify = (a, b) => {
  if (a === 'NULL') return b;
  if (b === 'NULL' || a === b) return a;
  if (TEXTUAL.has(a) && TEXTUAL.has(b)) return a === 'T' ? b : (b === 'T' ? a : 'R');
  return null;
};

const fits = (arg, param, bindings) => {
  if (arg === 'NULL' || param === 'A') return true;
  if (param === 'X') {
    if (!GENERIC.has(arg)) return false;
    if (!bindings.X) {
      bindings.X = arg;  
      return true;
    }
    const merged = unify(bindings.X, arg);
    if (!merged) return false;
    bindings.X = merged;  
    return true;
  }
  if (param === 'T' && RICH.has(arg)) return true;
  return arg === param;
};

const matchOverload = (fn, overload, argTypes) => {
  const { params } = overload;
  const variadic = params.length > 0 && params[params.length - 1].variadic;
  const required = params.filter((p) => !p.optional).length;
  if (argTypes.length < required || (!variadic && argTypes.length > params.length)) return { arityMismatch: true };

  const bindings = {};
  for (let i = 0; i < argTypes.length; i += 1) {
    const param = params[Math.min(i, params.length - 1)];
    if (!fits(argTypes[i], param.type, bindings)) return { badArg: i, expected: param.type, bindings };
  }
  if (COMPARISONS.has(fn) && bindings.X && !ORDERED.has(bindings.X)) return { badArg: 0, expected: 'N', bindings };

  const ret = overload.ret === 'X' ? (bindings.X || 'NULL') : overload.ret;
  return { ret, params };
};

const checkCall = (fn, argTypes) => {
  const overloads = OVERLOADS[fn];
  let firstTypeError = null;

  for (let i = 0; i < overloads.length; i += 1) {
    const result = matchOverload(fn, overloads[i], argTypes);
    if (result.ret) return result;
    if (!result.arityMismatch && !firstTypeError) firstTypeError = result;
  }

  if (!firstTypeError) {
    const { min, max } = arity(fn);
    const expected = min === max ? min : `${min}${max === Infinity ? '+' : `-${max}`}`;
    ArgumentError.throwIncorrectNumberOfArguments(fn, expected, argTypes.length);
  }
  const { badArg, expected, bindings } = firstTypeError;
  return wrongType(fn, expected === 'X' ? (bindings.X || 'T') : expected, argTypes[badArg]);
};

const fieldReference = (fn, node) => {
  if (node.arguments.length !== 1) ArgumentError.throwIncorrectNumberOfArguments(fn, 1, node.arguments.length);
  if (node.arguments[0].type !== 'identifier') {
    throw new ArgumentError(`Function ${fn.toUpperCase()}() may only be used with a field.`, { function: fn });
  }
};

// Returns the type code of `node`, and records the matched parameter list of every call in
// `annotations` (a Map from AST node to { params, ret }) for the evaluator.
const ORDER_OPS = new Set(['lessThan', 'greaterThan']);
const isCall = (n, id) => n.type === 'callExpression' && n.id === id;

export const typecheck = (node, fieldTypes, annotations) => {
  let insideImage = 0;
  let hostedDepth = 0;
  const unresolved = [];
  const visit = (n, parent) => {
    switch (n.type) {
      case 'literal':
        return typeCode(n.dataType);
      case 'identifier': {
        const type = fieldTypes(n.name);
        if (type) return type;
        // Global merge fields ($ObjectType, $Action, $User...), report summary fields
        // (AMOUNT:SUM) and references inside org-only functions are context, not record data.
        if (n.name.startsWith('$') || n.name.includes(':') || hostedDepth > 0) {
          unresolved.push(n.name);
          return 'NULL';
        }
        throw new ReferenceError(`Field ${n.name} does not exist. Check spelling.`, { identifier: n.name });
      }
      case 'callExpression':
        break;
      default:
        throw new TypeError(`Unknown AST node ${n.type}`);
    }

    const fn = n.id;
    if (fn === '$params') {
      n.arguments.forEach((a) => visit(a, n));
      return 'NULL';
    }
    // GEOLOCATION only exists as an argument of DISTANCE, and DISTANCE may only be compared
    // with < or > (Salesforce rejects both at save time).
    if (fn === 'geolocation' && !(parent && isCall(parent, 'distance'))) {
      throw new ArgumentError('GEOLOCATION() can only be used inside DISTANCE().', { function: fn });
    }
    if (parent && parent.type === 'callExpression' && COMPARISON_IDS.has(parent.id) && !ORDER_OPS.has(parent.id) && fn === 'distance') {
      throw new ArgumentError('DISTANCE() can only be compared with < or >.', { function: fn });
    }
    if (!(fn in OVERLOADS)) throw new NoFunctionError(`Unknown function ${fn.toUpperCase()}. Check spelling.`, { function: fn });

    if (fn === 'ischanged' || fn === 'priorvalue') {
      fieldReference(fn, n);
      const type = visit(n.arguments[0], n);
      const ret = fn === 'ischanged' ? 'B' : type;
      annotations.set(n, { ret });
      return ret;
    }

    if (fn === 'case') {
      const types = n.arguments.map((a) => visit(a, n));
      if (types.length < 4 || types.length % 2 !== 0) {
        ArgumentError.throwIncorrectNumberOfArguments(fn, types.length < 4 ? 4 : types.length + 1, types.length);
      }
      const subject = types[0];
      if (subject === 'MP' || subject === 'G' || subject === 'H' || subject === 'I') wrongType(fn, 'T', subject);
      // "CASE functions can't contain functions that return true or false" (CASE help page).
      const resultTypes = types.filter((_, i) => i > 0 && (i % 2 === 0 || i === types.length - 1));
      if (subject === 'B' || resultTypes.includes('B')) {
        throw new ArgumentError("CASE() can't contain expressions that return true or false.", { function: fn });
      }
      const valueType = subject === 'P' ? 'T' : subject;
      let ret = 'NULL';
      for (let i = 1; i < types.length; i += 1) {
        const isResult = i % 2 === 0 || i === types.length - 1;
        if (isResult) {
          if (!GENERIC.has(types[i]) && types[i] !== 'NULL') wrongType(fn, ret === 'NULL' ? 'T' : ret, types[i]);
          const merged = unify(ret, types[i]);
          if (!merged) wrongType(fn, ret, types[i]);
          ret = merged;
        } else if (!unify(valueType, types[i]) && types[i] !== 'NULL') {
          wrongType(fn, valueType, types[i]);
        }
      }
      annotations.set(n, { ret });
      return ret;
    }

    if (fn === 'getsessionid' && insideImage > 0) {
      throw new ArgumentError('IMAGE() cannot take GETSESSIONID() as an argument.', { function: 'image' });
    }
    if (fn === 'image') insideImage += 1;
    if (HOSTED.has(fn)) hostedDepth += 1;
    const argTypes = n.arguments.map((a) => visit(a, n));
    if (fn === 'image') insideImage -= 1;
    if (HOSTED.has(fn)) hostedDepth -= 1;
    const result = checkCall(fn, argTypes);
    // LEFT(Field__c, -5) is an error even in an untaken CASE branch ("illogical", CASE help page;
    // Common Formula Errors). A negative count computed at run time is treated as 0 instead.
    if ((fn === 'left' || fn === 'right') && n.arguments[1]?.type === 'literal' && n.arguments[1].value < 0) {
      throw new EvaluationError(`#Error! ${fn.toUpperCase()}() cannot take a negative number of characters.`, { function: fn });
    }
    if (fn === 'prevgroupval' && n.arguments[2]?.type === 'literal' && n.arguments[2].value > 12) {
      throw new ArgumentError('PREVGROUPVAL() increment cannot be more than 12.', { function: fn });
    }
    // INCLUDES and ISPICKVAL compare against a value written in the formula, never a field or a
    // function result; INCLUDES also rejects a blank one.
    if ((fn === 'includes' || fn === 'ispickval') && n.arguments[1]) {
      const literal = n.arguments[1];
      if (literal.type !== 'literal' || literal.dataType !== 'text') {
        throw new ArgumentError(`${fn.toUpperCase()}() needs a text literal as its second parameter.`, { function: fn });
      }
      if (fn === 'includes' && literal.value.trim() === '') {
        throw new ArgumentError('INCLUDES() needs a non-blank text literal.', { function: fn });
      }
    }
    // Text joined with a link or image stays renderable: the result is html.
    if ((fn === 'concat' || (fn === 'add' && result.ret === 'T')) && argTypes.some((t) => RICH.has(t))) result.ret = 'R';
    annotations.set(n, result);
    return result.ret;
  };

  const type = visit(node, null);
  if (unresolved.length) {
    throw new NotSupportedError(`${unresolved[0]} needs Salesforce org context that was not provided.`, { identifier: unresolved[0] });
  }
  return type;
};
