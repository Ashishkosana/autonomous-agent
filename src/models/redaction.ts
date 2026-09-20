/**
 * Removes credentials from text that may leave the provider adapter: error
 * messages, event payloads, diagnostics. Two layers, both cheap:
 *
 * 1. exact values the adapter was configured with (the API key, extra header
 *    values) — replaced wherever they appear;
 * 2. shapes that are credentials by convention (bearer tokens, `sk-…` style
 *    keys, `api_key=` query parameters) — replaced even if the adapter was
 *    never told about them, e.g. a key echoed back by a proxy.
 *
 * Redaction is applied to *outgoing* text only. Prompts and completions are
 * never emitted anywhere, so they are not redacted; they are simply not
 * copied.
 */
export const REDACTED = '[REDACTED]';

const MIN_SECRET_LENGTH = 8;

const CONVENTIONAL_PATTERNS: readonly RegExp[] = [
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(api[_-]?key|token|authorization)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi,
];

/**
 * The secret values are held off the instance (a redactor is often a field of
 * something that gets inspected or serialised in diagnostics).
 */
const knownSecrets = new WeakMap<SecretRedactor, readonly string[]>();

export class SecretRedactor {
  readonly secretCount: number;

  constructor(secrets: readonly (string | undefined)[] = []) {
    const kept = secrets
      .filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH)
      .sort((a, b) => b.length - a.length);
    knownSecrets.set(this, kept);
    this.secretCount = kept.length;
  }

  private get secrets(): readonly string[] {
    return knownSecrets.get(this) ?? [];
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `SecretRedactor(${this.secretCount} secret${this.secretCount === 1 ? '' : 's'})`;
  }

  toJSON(): { readonly secretCount: number } {
    return { secretCount: this.secretCount };
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED);
    for (const pattern of CONVENTIONAL_PATTERNS) {
      out = out.replace(pattern, (_match, ...groups: unknown[]) => {
        const prefix = typeof groups[0] === 'string' ? groups[0] : '';
        if (!prefix) return REDACTED;
        const separator = typeof groups[1] === 'string' ? groups[1] : ' ';
        return `${prefix}${separator}${REDACTED}`;
      });
    }
    return out;
  }

  /** True when the text still contains any configured secret (used by tests and self-checks). */
  containsSecret(text: string): boolean {
    return this.secrets.some((secret) => text.includes(secret));
  }
}
