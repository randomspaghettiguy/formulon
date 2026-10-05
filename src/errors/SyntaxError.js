import FormulonRuntimeError from './FormulonRuntimeError.js';

export default class FormulonSyntaxError extends FormulonRuntimeError {
  constructor(message, options) {
    super(message, 'SyntaxError', options);
  }
}
