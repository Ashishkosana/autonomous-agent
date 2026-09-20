import { describe, expect, it } from 'vitest';
import { ModelProviderError, errorKindOf, isRetryableModelError } from '../../src/models/errors.js';
import { REDACTED, SecretRedactor } from '../../src/models/redaction.js';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

describe('ModelProviderError', () => {
  it('marks only transient kinds as retryable', () => {
    const retryable = ['rate_limited', 'network', 'timeout', 'server'] as const;
    const fixed = [
      'authentication',
      'bad_request',
      'invalid_response',
      'configuration',
      'unknown',
    ] as const;
    for (const kind of retryable) expect(new ModelProviderError('x', kind).retryable).toBe(true);
    for (const kind of fixed) expect(new ModelProviderError('x', kind).retryable).toBe(false);
  });

  it('carries status and Retry-After and classifies foreign errors as unknown', () => {
    const error = new ModelProviderError('slow down', 'rate_limited', {
      status: 429,
      retryAfterMs: 1500,
    });
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(1500);
    expect(errorKindOf(error)).toBe('rate_limited');
    expect(errorKindOf(new Error('boom'))).toBe('unknown');
    expect(isRetryableModelError(new Error('boom'))).toBe(false);
  });
});

describe('SecretRedactor', () => {
  it('removes every configured secret value wherever it appears', () => {
    const redactor = new SecretRedactor([KEY, 'ref-header-value-123']);
    const text = `HTTP 401: {"error":"key ${KEY} invalid"} referer ref-header-value-123 ${KEY}`;
    const out = redactor.redact(text);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('ref-header-value-123');
    expect(out).toContain(REDACTED);
    expect(redactor.containsSecret(out)).toBe(false);
  });

  it('removes credential-shaped values it was never told about', () => {
    const redactor = new SecretRedactor([]);
    expect(redactor.redact('Authorization: Bearer abcdefghijklmnop')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactor.redact('token sk-abcdefghijklmnop leaked')).toBe(`token ${REDACTED} leaked`);
    expect(redactor.redact('api_key=abcdefghijklmnop&x=1')).toBe(`api_key=${REDACTED}&x=1`);
  });

  it('ignores short or missing secrets so ordinary words are not redacted', () => {
    const redactor = new SecretRedactor(['abc', undefined, '']);
    expect(redactor.redact('abc is a normal word')).toBe('abc is a normal word');
  });
});
