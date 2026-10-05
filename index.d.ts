// Type definitions for formulon.

export type FieldType =
  | 'number' | 'currency' | 'percent' | 'double' | 'integer' | 'int' | 'long'
  | 'text' | 'string' | 'textarea' | 'email' | 'phone' | 'url' | 'id' | 'reference' | 'encryptedstring'
  | 'checkbox' | 'boolean'
  | 'date' | 'datetime' | 'time'
  | 'picklist' | 'multipicklist'
  | 'geolocation' | 'location';

/** One field value. Dates may be `Date` objects or strings: date `YYYY-MM-DD`, datetime ISO 8601,
 * time `HH:mm:ss.sss`. A Percent field of 50% is the number `0.5`. */
export interface FieldInput {
  type: FieldType;
  value: number | string | boolean | Date | string[] | [number, number] | { latitude: number; longitude: number } | null;
  /** Allowed picklist values (informational). */
  values?: string[];
}

/** Field values by API name; cross-object and global references use dotted names:
 * `Account.Name`, `$User.Id`. Names are case-insensitive. */
export type Inputs = Record<string, FieldInput>;

export interface HostContext {
  /** Value for GETSESSIONID(). */
  sessionId?: string;
  /** Exchange rate for CURRENCYRATE(isoCode). */
  currencyRate?: (isoCode: string) => number;
  /** Org-backed functions; each receives evaluated literals and returns a literal. */
  vlookup?: (...args: Literal[]) => Literal;
  getrecordids?: (...args: Literal[]) => Literal;
  imageproxyurl?: (...args: Literal[]) => Literal;
  include?: (...args: Literal[]) => Literal;
  junctionidlist?: (...args: Literal[]) => Literal;
  linkto?: (...args: Literal[]) => Literal;
  predict?: (...args: Literal[]) => Literal;
  requirescript?: (...args: Literal[]) => Literal;
  urlfor?: (...args: Literal[]) => Literal;
  parentgroupval?: (...args: Literal[]) => Literal;
  prevgroupval?: (...args: Literal[]) => Literal;
}

export interface EvaluateOptions {
  /** Clock for TODAY(), NOW(), TIMENOW(). Defaults to the current time. Time zone is GMT. */
  now?: string | Date;
  /** The formula field's "Treat blank fields as" setting. Default 'blank'. */
  blankAs?: 'blank' | 'zero';
  /** Declared return type of the formula field; a mismatch is a ReturnTypeError. */
  returnType?: 'number' | 'currency' | 'percent' | 'text' | 'checkbox' | 'date' | 'datetime' | 'time';
  /** Decimal places of a number/currency/percent formula field. */
  scale?: number;
  /** Field values before the change, for ISCHANGED() and PRIORVALUE(). */
  prior?: Inputs;
  /** ISNEW() */
  isNew?: boolean;
  /** ISCLONE() */
  isClone?: boolean;
  /** Implementations of functions that need a live org. Without them those functions return
   * a NotSupportedError instead of an invented value. */
  context?: HostContext;
}

export interface Hyperlink {
  url: string;
  /** Text, or an image when the link wraps IMAGE(...). */
  label: string | Image;
  target: string | null;
}

export interface Image {
  url: string;
  alt: string;
  height: number | null;
  width: number | null;
}

export type Literal =
  | { type: 'literal'; dataType: 'number'; value: number | null; options: object }
  | { type: 'literal'; dataType: 'text'; value: string | null; options: object }
  | { type: 'literal'; dataType: 'checkbox'; value: boolean; options: object }
  | { type: 'literal'; dataType: 'date' | 'datetime' | 'time'; value: Date | null; options: object }
  | { type: 'literal'; dataType: 'geolocation'; value: [number, number] | null; options: object }
  | { type: 'literal'; dataType: 'picklist'; value: string | null; options: object }
  | { type: 'literal'; dataType: 'multipicklist'; value: string[] | null; options: object }
  | { type: 'literal'; dataType: 'hyperlink'; value: Hyperlink; options: object }
  | { type: 'literal'; dataType: 'image'; value: Image; options: object }
  /** Text joined with links/images. Every text piece is HTML-escaped; only the generated
   * <a> and <img> tags are markup, so it is safe to render as HTML. */
  | { type: 'literal'; dataType: 'html'; value: string; options: object }
  | { type: 'literal'; dataType: 'null'; value: null; options: object };

export type ErrorType =
  | 'SyntaxError'
  | 'ArgumentError'
  | 'ReferenceError'
  | 'NoFunctionError'
  /** Salesforce shows #Error!: division by zero, invalid date, VALUE("abc"), text too long... */
  | 'RuntimeError'
  | 'NotSupportedError'
  | 'ReturnTypeError'
  /** A bug in this library. Please report it with the formula. */
  | 'InternalError';

export interface FormulaError {
  type: 'error';
  errorType: ErrorType;
  message: string;
  [detail: string]: unknown;
}

export type Result = Literal | FormulaError;

/** Evaluate a formula. Never throws. Compiled formulas are cached by text. */
export function evaluate(formula: string, inputs?: Inputs, options?: EvaluateOptions): Result;

export interface CompiledFormula {
  /** The parse tree, or null when the formula has a syntax error. */
  ast: object | null;
  /** Field names the formula references, in order of first use. */
  references: string[];
  /** The syntax error, if any. */
  error: FormulaError | null;
  evaluate(inputs?: Inputs, options?: EvaluateOptions): Result;
}

/** Parse once, evaluate against many records. */
export function compile(formula: string): CompiledFormula;

/** Every function name the library knows, upper case. */
export function functionNames(): string[];

/** Formulon's original API: `substitutions` in the { type: 'literal', dataType, value } shape. */
export function parse(formula: string, substitutions?: Record<string, object>, options?: EvaluateOptions): Result;
export function extract(formula: string): string[];
export function ast(formula: string): object;
export function toString(literal: Literal): string;
