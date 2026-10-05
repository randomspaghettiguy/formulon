import { compile, evaluate } from './evaluate.js';
import { formatLiteral } from './utils.js';
import { SIGNATURES } from './signatures.js';

export { compile, evaluate };

// Every function name this library knows, upper case.
export const functionNames = () => Object.keys(SIGNATURES)
  .filter((name) => /^[a-z0-9]+$/.test(name))
  .map((name) => name.toUpperCase());

// Formulon's original entry point: evaluate with { Name: { type: 'literal', dataType, value } }.
export const parse = (formula, substitutions = {}, options = {}) => {
  if (formula == null || formula.trim() === '') {
    return {
      type: 'literal', value: '', dataType: 'text', options: { length: 0 },
    };
  }
  return evaluate(formula, substitutions, options);
};

// Field names a formula references, in order of first use.
export const extract = (formula) => {
  if (formula == null || formula.trim() === '') return [];
  return compile(formula).references;
};

export const ast = (formula) => {
  if (formula == null || formula.trim() === '') return {};
  const compiled = compile(formula);
  return compiled.error ?? compiled.ast;
};

export const toString = (literal) => formatLiteral(literal);
