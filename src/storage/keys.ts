import { StorageError } from './errors.js';

/**
 * Object keys are a backend-neutral namespace: `/`-separated segments of
 * `[A-Za-z0-9._-]`, no empty or dot-only segments, no leading slash. The rule
 * is strict on purpose so that a key can be mapped onto a filesystem path, an
 * R2/S3 object name or a database column without escaping — and so that no
 * key can ever name something outside the storage root.
 */
export const MAX_KEY_LENGTH = 512;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function keyProblems(key: string): string[] {
  if (typeof key !== 'string' || key.length === 0) return ['key must be a non-empty string'];
  if (key.length > MAX_KEY_LENGTH) return [`key longer than ${MAX_KEY_LENGTH} characters`];
  const problems: string[] = [];
  const segments = key.split('/');
  for (const segment of segments) {
    if (segment === '') {
      problems.push('empty path segment (leading, trailing or doubled "/")');
      break;
    }
    if (segment === '.' || segment === '..') {
      problems.push(`path segment "${segment}" is not allowed`);
      break;
    }
    if (!SEGMENT.test(segment)) {
      problems.push(
        `segment "${segment}" must start with a letter or digit and use only [A-Za-z0-9._-]`,
      );
      break;
    }
  }
  return problems;
}

export function assertValidKey(key: string): void {
  const problems = keyProblems(key);
  if (problems.length > 0) {
    throw new StorageError(`Invalid object key: ${problems.join('; ')}`, 'invalid_key', key);
  }
}

/** Prefixes are looser: empty means "everything", otherwise a valid key with an optional trailing "/". */
export function assertValidPrefix(prefix: string): void {
  if (prefix === '') return;
  assertValidKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
}
