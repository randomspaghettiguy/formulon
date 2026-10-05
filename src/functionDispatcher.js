// dispatch(name, literals): call one function with already evaluated arguments, with the same
// type checking and blank handling as a formula. Kept for callers of formulon's old API.
import { evaluateAst } from './evaluate.js';

const dispatch = (name, args) => {
  const error = args.find((arg) => arg.type === 'error');
  if (error) return error;
  return evaluateAst({ type: 'callExpression', id: name, arguments: args });
};

export default dispatch;
