import { isRecord, parseFail, type ParseResult } from '../../domain/parse.js';

/**
 * Small readers for model-proposed tool input. They accumulate errors so a
 * rejected proposal tells the model everything that was wrong at once.
 */
export function requireObject(raw: unknown): ParseResult<Record<string, unknown>> {
  return isRecord(raw) ? { ok: true, value: raw } : parseFail('input must be a JSON object');
}

export function optionalString(
  source: Record<string, unknown>,
  key: string,
  errors: string[],
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  errors.push(`${key} must be a string when present`);
  return undefined;
}

export function requiredString(
  source: Record<string, unknown>,
  key: string,
  errors: string[],
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string {
  const value = source[key];
  if (typeof value === 'string' && (allowEmpty || value.length > 0)) return value;
  errors.push(allowEmpty ? `${key} must be a string` : `${key} must be a non-empty string`);
  return '';
}

export function optionalInteger(
  source: Record<string, unknown>,
  key: string,
  errors: string[],
  { min, max }: { min?: number; max?: number } = {},
): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${key} must be a number when present`);
    return undefined;
  }
  const rounded = Math.floor(value);
  if (min !== undefined && rounded < min) errors.push(`${key} must be >= ${min}`);
  if (max !== undefined && rounded > max) errors.push(`${key} must be <= ${max}`);
  return rounded;
}

export function optionalStringArray(
  source: Record<string, unknown>,
  key: string,
  errors: string[],
): string[] {
  const value = source[key];
  if (value === undefined || value === null) return [];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  errors.push(`${key} must be an array of strings when present`);
  return [];
}

export function optionalStringRecord(
  source: Record<string, unknown>,
  key: string,
  errors: string[],
): Record<string, string> {
  const value = source[key];
  if (value === undefined || value === null) return {};
  if (isRecord(value) && Object.values(value).every((item) => typeof item === 'string')) {
    return value as Record<string, string>;
  }
  errors.push(`${key} must be an object of string values when present`);
  return {};
}

export function optionalEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  errors: string[],
): T | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T;
  errors.push(`${key} must be one of ${allowed.join(', ')}`);
  return undefined;
}
