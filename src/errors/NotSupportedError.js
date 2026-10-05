import FormulonRuntimeError from './FormulonRuntimeError.js';

export default class FormulonNotSupportedError extends FormulonRuntimeError {
  constructor(message, options) {
    super(message, 'NotSupportedError', options);
  }
}
