import FormulonRuntimeError from './FormulonRuntimeError.js';

export default class FormulonReturnTypeError extends FormulonRuntimeError {
  constructor(message, options) {
    super(message, 'ReturnTypeError', options);
  }
}
