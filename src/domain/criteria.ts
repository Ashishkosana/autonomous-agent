/**
 * Mechanically checkable success criteria. Supplied by the caller (the human
 * goal), never by the model. A string that does not match this grammar is
 * prose: the deterministic evaluator records it as not checkable and does
 * not treat it as passed or failed.
 *
 * Grammar, one criterion per string:
 *   file_exists:<path>
 *   file_contains:<path>|<marker>
 *   json_file:<path>
 *   json_file:<path>|<key>,<key>
 *   command_exits_zero:<command>
 *   http_status:<code>
 *   tool_succeeded
 *   tool_succeeded:<tool name>
 *
 * `command_exits_zero` runs inside the execution environment, which is the
 * existing sandbox boundary. It is not a host shell.
 */
export type VerifiableCriterion =
  | { readonly kind: 'file_exists'; readonly path: string }
  | { readonly kind: 'file_contains'; readonly path: string; readonly marker: string }
  | { readonly kind: 'json_file'; readonly path: string; readonly requiredKeys?: readonly string[] }
  | { readonly kind: 'command_exits_zero'; readonly command: string }
  | { readonly kind: 'http_status'; readonly status: number }
  | { readonly kind: 'tool_succeeded'; readonly toolName?: string };

const PREFIXES = [
  'file_exists:',
  'file_contains:',
  'json_file:',
  'command_exits_zero:',
  'http_status:',
  'tool_succeeded',
] as const;

export function parseVerifiableCriterion(text: string): VerifiableCriterion | undefined {
  const raw = text.trim();
  if (raw === 'tool_succeeded') return { kind: 'tool_succeeded' };
  if (raw.startsWith('tool_succeeded:')) {
    const toolName = raw.slice('tool_succeeded:'.length).trim();
    return toolName === '' ? undefined : { kind: 'tool_succeeded', toolName };
  }
  if (raw.startsWith('file_exists:')) {
    const path = raw.slice('file_exists:'.length).trim();
    return path === '' ? undefined : { kind: 'file_exists', path };
  }
  if (raw.startsWith('file_contains:')) {
    const rest = raw.slice('file_contains:'.length);
    const split = rest.indexOf('|');
    if (split <= 0) return undefined;
    const path = rest.slice(0, split).trim();
    const marker = rest.slice(split + 1);
    if (path === '' || marker === '') return undefined;
    return { kind: 'file_contains', path, marker };
  }
  if (raw.startsWith('json_file:')) {
    const rest = raw.slice('json_file:'.length);
    const split = rest.indexOf('|');
    if (split === -1) {
      const path = rest.trim();
      return path === '' ? undefined : { kind: 'json_file', path };
    }
    const path = rest.slice(0, split).trim();
    const keys = rest
      .slice(split + 1)
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key !== '');
    if (path === '') return undefined;
    return { kind: 'json_file', path, ...(keys.length > 0 ? { requiredKeys: keys } : {}) };
  }
  if (raw.startsWith('command_exits_zero:')) {
    const command = raw.slice('command_exits_zero:'.length).trim();
    return command === '' ? undefined : { kind: 'command_exits_zero', command };
  }
  if (raw.startsWith('http_status:')) {
    const status = Number(raw.slice('http_status:'.length).trim());
    if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
    return { kind: 'http_status', status };
  }
  return undefined;
}

export function looksLikeCriterionPrefix(text: string): boolean {
  const raw = text.trim();
  return PREFIXES.some((prefix) => raw === prefix || raw.startsWith(prefix));
}

/** Structured criteria plus any success-criteria strings that match the grammar. */
export function collectCriteria(
  structured: readonly VerifiableCriterion[] | undefined,
  prose: readonly string[],
): {
  readonly criteria: readonly VerifiableCriterion[];
  readonly uncheckedProse: readonly string[];
} {
  const criteria: VerifiableCriterion[] = [...(structured ?? [])];
  const uncheckedProse: string[] = [];
  for (const line of prose) {
    const parsed = parseVerifiableCriterion(line);
    if (parsed) criteria.push(parsed);
    else if (line.trim() !== '') uncheckedProse.push(line.trim());
  }
  return { criteria, uncheckedProse };
}
