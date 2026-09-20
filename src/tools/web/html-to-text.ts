/**
 * Reduces an HTML document to readable text for a model: drops scripts,
 * styles and markup, keeps block structure as line breaks, decodes the
 * common entities. Deliberately simple — it is not a browser (Phase 9) and
 * does not execute anything.
 */
export interface ExtractedPage {
  readonly title: string | undefined;
  readonly text: string;
}

const BLOCK_TAGS =
  'p|div|br|hr|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|nav|blockquote|pre|dd|dt|dl|figure|figcaption|aside|main|form|fieldset|address';

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

export function decodeEntities(text: string): string {
  return text.replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return safeCodePoint(Number.parseInt(lower.slice(2), 16), whole);
    if (lower.startsWith('#')) return safeCodePoint(Number.parseInt(lower.slice(1), 10), whole);
    return ENTITIES[lower] ?? whole;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

export function htmlToText(html: string): ExtractedPage {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? collapse(decodeEntities(stripTags(titleMatch[1] ?? ''))) : undefined;
  const withoutNoise = html
    .replaceAll(/<!--[\s\S]*?-->/g, ' ')
    .replaceAll(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const withBreaks = withoutNoise.replaceAll(
    new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'),
    '\n',
  );
  const text = decodeEntities(stripTags(withBreaks))
    .split('\n')
    .map((line) => collapse(line))
    .filter((line) => line.length > 0)
    .join('\n');
  return { title: title && title.length > 0 ? title : undefined, text };
}

function stripTags(html: string): string {
  return html.replaceAll(/<[^>]+>/g, ' ');
}

function collapse(text: string): string {
  return text.replaceAll(/[ \t\r\f\v\u00a0]+/g, ' ').trim();
}
