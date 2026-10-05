import FormulonRuntimeError from './FormulonRuntimeError.js';

export default class ReferenceError extends FormulonRuntimeError {
  constructor(message, options) {
    super(message, 'ReferenceError', options);
  }
}
