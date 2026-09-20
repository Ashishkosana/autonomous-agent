import { parseFail, parseOk, type ParseResult } from '../../domain/parse.js';

/**
 * Resolves a model-proposed path against the sandbox workspace root and
 * refuses anything that would leave it. The sandbox itself is the hard
 * boundary (the agent user cannot write outside it anyway); this keeps the
 * agent's own view of "its files" coherent and makes escapes an explicit,
 * observable input rejection instead of a confusing permission error.
 *
 * Pure string logic over POSIX paths — no filesystem access, no host paths.
 */
export function resolveWorkspacePath(workspaceRoot: string, input: string): ParseResult<string> {
  if (input.length === 0) return parseFail('path must be a non-empty string');
  if (input.includes('\0')) return parseFail('path must not contain NUL');
  const root = normalisePosix(workspaceRoot);
  const candidate = input.startsWith('/')
    ? normalisePosix(input)
    : normalisePosix(`${root}/${input}`);
  if (candidate === root || candidate.startsWith(`${root}/`)) return parseOk(candidate);
  return parseFail(`path must stay inside the workspace ${root}: ${input}`);
}

/** Collapses `.` and `..` segments and repeated slashes; never touches the disk. */
export function normalisePosix(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

export function posixDirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}
