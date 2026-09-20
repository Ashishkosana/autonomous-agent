import { describe, expect, it } from 'vitest';
import { capText } from '../../src/tools/support/output.js';
import { clampTimeout, resolveToolOptions } from '../../src/tools/support/options.js';
import { shellJoin, shellQuote } from '../../src/tools/support/shell.js';
import { normalisePosix, resolveWorkspacePath } from '../../src/tools/support/workspace-path.js';

describe('shell quoting', () => {
  it('leaves safe words alone and single-quotes everything else', () => {
    expect(shellQuote('python3')).toBe('python3');
    expect(shellQuote('/workspace/a-b_c.txt')).toBe('/workspace/a-b_c.txt');
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('hello world')).toBe("'hello world'");
    expect(shellQuote('$HOME')).toBe("'$HOME'");
    expect(shellQuote('a;rm -rf /')).toBe("'a;rm -rf /'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('line1\nline2')).toBe("'line1\nline2'");
    expect(shellQuote('`id`')).toBe("'`id`'");
  });

  it('joins argv so the shell sees exactly the original words', () => {
    expect(shellJoin(['printf', '%s', "a b'c", '$X'])).toBe(`printf %s 'a b'\\''c' '$X'`);
  });
});

describe('workspace path confinement', () => {
  const root = '/workspace';
  it('accepts relative and absolute paths inside the workspace', () => {
    expect(resolveWorkspacePath(root, 'report.md')).toEqual({
      ok: true,
      value: '/workspace/report.md',
    });
    expect(resolveWorkspacePath(root, './a/./b//c.txt')).toEqual({
      ok: true,
      value: '/workspace/a/b/c.txt',
    });
    expect(resolveWorkspacePath(root, '/workspace/x/../y')).toEqual({
      ok: true,
      value: '/workspace/y',
    });
    expect(resolveWorkspacePath(root, '/workspace')).toEqual({ ok: true, value: '/workspace' });
  });

  it('rejects every way out of the workspace', () => {
    for (const escape of [
      '../etc/passwd',
      '/etc/passwd',
      'a/../../b',
      '/workspace/../root',
      '/workspacex/y',
    ]) {
      const result = resolveWorkspacePath(root, escape);
      expect(result.ok, escape).toBe(false);
      if (!result.ok) expect(result.errors[0]).toMatch(/inside the workspace/);
    }
    expect(resolveWorkspacePath(root, '').ok).toBe(false);
    expect(resolveWorkspacePath(root, 'a\0b').ok).toBe(false);
  });

  it('normalises without touching the filesystem', () => {
    expect(normalisePosix('/a//b/./c/../d/')).toBe('/a/b/d');
    expect(normalisePosix('/../..')).toBe('/');
  });
});

describe('output caps and timeouts', () => {
  it('marks truncation explicitly and keeps the original length', () => {
    expect(capText('short', 10)).toEqual({ text: 'short', truncated: false, originalLength: 5 });
    const capped = capText('x'.repeat(100), 10);
    expect(capped.truncated).toBe(true);
    expect(capped.originalLength).toBe(100);
    expect(capped.text).toBe(`${'x'.repeat(10)}…[truncated 90 chars]`);
  });

  it('a proposal can shorten a timeout but never exceed the ceiling', () => {
    const options = resolveToolOptions({ defaultTimeoutMs: 5_000, maxTimeoutMs: 10_000 });
    expect(clampTimeout(options, undefined)).toBe(5_000);
    expect(clampTimeout(options, 2_500)).toBe(2_500);
    expect(clampTimeout(options, 999_999)).toBe(10_000);
    expect(clampTimeout(options, 1)).toBe(1_000);
  });
});
