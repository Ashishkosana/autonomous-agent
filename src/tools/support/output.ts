/**
 * Tool outputs go back into the model's context and into events, so their
 * size is bounded here — once, the same way for every tool. The cap is
 * recorded alongside the text so nobody can mistake a truncated result for
 * the whole thing.
 */
export interface CappedText {
  readonly text: string;
  readonly truncated: boolean;
  /** Length of the original text in UTF-16 code units. */
  readonly originalLength: number;
}

export function capText(text: string, maxChars: number): CappedText {
  if (text.length <= maxChars) return { text, truncated: false, originalLength: text.length };
  return {
    text: `${text.slice(0, Math.max(0, maxChars))}…[truncated ${text.length - maxChars} chars]`,
    truncated: true,
    originalLength: text.length,
  };
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
