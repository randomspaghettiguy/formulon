import FormulonRuntimeError from './FormulonRuntimeError.js';

export default class NoFunctionError extends FormulonRuntimeError {
  constructor(message, options) {
    super(message, 'NoFunctionError', options);
  }
}
