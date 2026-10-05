import FormulonRuntimeError from './FormulonRuntimeError.js';

export default class FormulonEvaluationError extends FormulonRuntimeError {
  constructor(message, options) {
    super(message, 'RuntimeError', options);
  }
}
