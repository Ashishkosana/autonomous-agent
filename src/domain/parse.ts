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

/** Small helpers for hand-written validators of untrusted structured output. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(source: Record<string, unknown>, key: string, errors: string[]): string {
  const value = source[key];
  if (typeof value === 'string' && value.length > 0) return value;
  errors.push(`${key} must be a non-empty string`);
  return '';
}

export function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  errors: string[],
): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  errors.push(`${key} must be a string when present`);
  return undefined;
}

export function readStringArray(
  source: Record<string, unknown>,
  key: string,
  errors: string[],
  { optional = false }: { optional?: boolean } = {},
): string[] {
  const value = source[key];
  if (value === undefined && optional) return [];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  errors.push(`${key} must be an array of strings`);
  return [];
}

export function readBoolean(
  source: Record<string, unknown>,
  key: string,
  errors: string[],
  fallback?: boolean,
): boolean {
  const value = source[key];
  if (typeof value === 'boolean') return value;
  if (value === undefined && fallback !== undefined) return fallback;
  errors.push(`${key} must be a boolean`);
  return false;
}

export function readOptionalNumber(
  source: Record<string, unknown>,
  key: string,
  errors: string[],
): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  errors.push(`${key} must be a finite number when present`);
  return undefined;
}

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
