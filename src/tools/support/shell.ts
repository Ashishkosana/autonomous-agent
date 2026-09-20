/**
 * POSIX shell quoting for commands the tools build from model-proposed
 * strings. Every argument is wrapped in single quotes, with embedded single
 * quotes spliced as '\'' — the only quoting the Bourne shell never
 * interprets. Tools must never interpolate untrusted text any other way.
 */
export function shellQuote(argument: string): string {
  if (argument === '') return "''";
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(argument)) return argument;
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}
