import { parseVerifiableCriterion, type VerifiableCriterion } from '../domain/criteria.js';

export interface ParsedAgentArgs {
  readonly goalStatement: string;
  readonly constraints: readonly string[];
  readonly verifiableCriteria: readonly VerifiableCriterion[];
  readonly memoryRetrieval: 'on' | 'off';
}

export type ParseAgentResult =
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'run'; readonly args: ParsedAgentArgs };

const CRITERION_HINT =
  'expected file_exists:<path>, file_contains:<path>|<marker>, json_file:<path>[|<key>,<key>], command_exits_zero:<command>, http_status:<code>, or tool_succeeded[:<tool>]';

/**
 * Parses CLI argv after the node/script entries (`process.argv.slice(2)`).
 * Does not read the environment. `--help` wins over every other argument.
 */
export function parseAgentArgs(argv: readonly string[]): ParseAgentResult {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };

  const constraints: string[] = [];
  const criteria: VerifiableCriterion[] = [];
  const goalParts: string[] = [];
  const errors: string[] = [];
  let memoryRetrieval: 'on' | 'off' = 'on';
  let openFile: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    const split = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = split === -1 ? token : token.slice(0, split);
    const inline = split === -1 ? undefined : token.slice(split + 1);

    const readValue = (name: string): string | undefined => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        errors.push(`${name} needs a value`);
        return undefined;
      }
      i += 1;
      return next;
    };

    if (flag === '--require-file') {
      const path = readValue(flag)?.trim();
      if (path === undefined) continue;
      if (path === '') {
        errors.push('--require-file needs a non-empty path');
        continue;
      }
      criteria.push({ kind: 'file_exists', path });
      openFile = criteria.length - 1;
      continue;
    }

    if (flag === '--require-marker') {
      const marker = readValue(flag);
      if (marker === undefined) continue;
      if (marker === '') {
        errors.push('--require-marker needs a non-empty marker');
        continue;
      }
      const current = openFile === undefined ? undefined : criteria[openFile];
      if (!current || current.kind !== 'file_exists') {
        errors.push(
          '--require-marker must follow a --require-file that does not already have a marker',
        );
        continue;
      }
      criteria[openFile!] = { kind: 'file_contains', path: current.path, marker };
      openFile = undefined;
      continue;
    }

    if (flag === '--criterion') {
      const text = readValue(flag)?.trim();
      if (text === undefined) continue;
      const parsed = text === '' ? undefined : parseVerifiableCriterion(text);
      if (!parsed) {
        errors.push(
          `--criterion ${text === '' ? '(empty)' : `"${text}"`} is not a mechanical criterion (${CRITERION_HINT})`,
        );
        continue;
      }
      criteria.push(parsed);
      openFile = undefined;
      continue;
    }

    if (flag === '--constraint') {
      const text = readValue(flag)?.trim();
      if (text === undefined) continue;
      if (text === '') {
        errors.push('--constraint needs non-empty text');
        continue;
      }
      constraints.push(text);
      continue;
    }

    if (flag === '--memory') {
      const value = readValue(flag)?.trim();
      if (value === undefined) continue;
      if (value !== 'on' && value !== 'off') {
        errors.push('--memory must be on or off');
        continue;
      }
      memoryRetrieval = value;
      continue;
    }

    if (flag.startsWith('-')) {
      errors.push(`unknown option ${flag}`);
      continue;
    }

    goalParts.push(token);
  }

  if (errors.length > 0) return { kind: 'error', message: errors.join('\n') };
  const goalStatement = goalParts.join(' ').trim();
  if (goalStatement === '') {
    return {
      kind: 'error',
      message:
        'a goal is required. Interactive prompting is not implemented.\nExample: npm run agent -- "Create /workspace/hello.txt" --require-file /workspace/hello.txt --require-marker AGENT_ALIVE',
    };
  }
  return {
    kind: 'run',
    args: { goalStatement, constraints, verifiableCriteria: criteria, memoryRetrieval },
  };
}
