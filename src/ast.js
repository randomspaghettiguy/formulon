import dispatch from './functionDispatcher.js';
import ReferenceError from './errors/ReferenceError.js';

import { parseFormula } from './parser.js';
import FormulonRuntimeError from './errors/FormulonRuntimeError.js';
import { buildErrorLiteral, handleFormulonError } from './utils.js';

const traverseAndThrow = (ast) => {
  switch (ast.type) {
    case 'callExpression':
      return dispatch(ast.id, ast.arguments.map((arg) => traverseAndThrow(arg)));
    case 'identifier':
      throw new ReferenceError(`Field ${ast.name} does not exist. Check spelling.`, { identifier: ast.name });
    default:
      return ast;
  }
};

// public

export const build = (formula) => {
  try {
    return parseFormula(formula == null ? '' : formula.trim());
  } catch (err) {
    if (err instanceof FormulonRuntimeError) {
      return buildErrorLiteral(err.errorType, err.message, err.options);
    }

    throw err;
  }
};

export const traverse = (ast) => handleFormulonError(() => traverseAndThrow(ast));

export const extract = (ast, state = []) => {
  switch (ast.type) {
    case 'callExpression':
      return ast.arguments.map((arg) => extract(arg, state)).reduce((a, b) => a.concat(b), []);
    case 'identifier':
      return state.concat(ast.name);
    default:
      return state;
  }
};

export const replace = (ast, replacement) => {
  if (ast.type === 'callExpression') {
    return {
      type: 'callExpression',
      id: ast.id,
      arguments: ast.arguments.map((arg) => replace(arg, replacement)),
    };
  }

  if (ast.type === 'identifier' && replacement[ast.name]) {
    return {

      ...replacement[ast.name],
      type: 'literal',
    };
  }

  return ast;
};
