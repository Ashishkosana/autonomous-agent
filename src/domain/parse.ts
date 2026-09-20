/**
 * Result of validating untrusted input (model output, tool input, stored
 * records) into a typed value. Used instead of throwing so that validation
 * failures become structured observations rather than crashes.
 */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

export const parseOk = <T>(value: T): ParseResult<T> => ({ ok: true, value });
export const parseFail = <T = never>(...errors: string[]): ParseResult<T> => ({
  ok: false,
  errors,
});

/**
 * Minimal JSON Schema representation. Tools and structured model requests
 * publish their schemas in this shape so that any model provider can be
 * given a machine-readable description of the expected input/output.
 * Validation itself is the responsibility of the tool/provider (`parseInput`).
 */
export interface JsonSchema {
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly additionalProperties?: boolean | JsonSchema;
}
