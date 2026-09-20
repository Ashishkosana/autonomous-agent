/**
 * The exact argv vectors `LocalLinuxEnvironment` executes inside the sandbox.
 * They are plain POSIX sh + GNU coreutils/findutils/procps, so they run on any
 * small Debian/Ubuntu image. Kept in one file so that:
 *
 * - the fake runtime can recognise them by identity instead of parsing shell,
 * - the namespace-based test runtime can execute them on a real Linux host,
 * - the ADR can cite them verbatim.
 *
 * Every argument that comes from the caller (paths, commands, ids) is passed
 * as a positional parameter — never interpolated into a script string.
 */

/** Where per-process bookkeeping (stdout, stderr, exit status) lives inside the container. */
export const PROCESS_DIR = '/tmp/.agent-proc';

export const WRITE_FILE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';

/**
 * Starts `$2` detached in its own session (so the whole process group can be
 * signalled later), records its exit status, and prints the leader PID.
 * `setsid` execs directly (no fork) because a background job of a
 * non-interactive shell is not a group leader, so `$!` IS the leader.
 */
export const START_PROCESS_SCRIPT = [
  `d="${PROCESS_DIR}/$1"`,
  'mkdir -p -- "$d"',
  `setsid sh -c 'sh -c "$1"; echo $? > "$2/exit"' sh "$2" "$d" >"$d/stdout" 2>"$d/stderr" </dev/null &`,
  'echo $!',
].join('\n');

/** Prints `running`, `exited <code>` or `gone` for the leader PID `$1` with exit file `$2`. */
export const PROCESS_STATUS_SCRIPT = [
  'if [ -f "$2" ]; then echo "exited $(cat -- "$2")"; exit 0; fi',
  'if [ -d "/proc/$1" ] && ! grep -q "^State:.*Z" "/proc/$1/status" 2>/dev/null; then echo running; else echo gone; fi',
].join('\n');

/**
 * SIGTERMs the process group of leader `$1`, waits up to `$2` tenths of a
 * second, then SIGKILLs. Exit 3 means there was nothing to signal.
 * `kill -s SIG -- -pgid` is the POSIX form; dash rejects `kill -TERM -- -pgid`.
 */
export const STOP_PROCESS_SCRIPT = [
  'pid="$1"; grace="$2"',
  'kill -s TERM -- "-$pid" 2>/dev/null || kill -s TERM -- "$pid" 2>/dev/null || exit 3',
  'i=0',
  'while [ "$i" -lt "$grace" ]; do',
  '  if [ -d "/proc/$pid" ] && ! grep -q "^State:.*Z" "/proc/$pid/status" 2>/dev/null; then sleep 0.1; i=$((i+1)); else exit 0; fi',
  'done',
  'kill -s KILL -- "-$pid" 2>/dev/null; kill -s KILL -- "$pid" 2>/dev/null; exit 0',
].join('\n');

/** `find` output format: type letter, size in bytes, name — tab separated. */
export const LIST_DIRECTORY_FORMAT = '%y\\t%s\\t%f\\n';

export const ContainerScripts = {
  runCommand(command: string, timeoutSeconds: number | undefined, killGraceSeconds: number) {
    const shell = ['sh', '-c', command] as const;
    return timeoutSeconds === undefined
      ? [...shell]
      : ['timeout', '-k', String(killGraceSeconds), String(timeoutSeconds), ...shell];
  },
  readFile(path: string) {
    return ['cat', '--', path];
  },
  writeFile(path: string) {
    return ['sh', '-c', WRITE_FILE_SCRIPT, 'sh', path];
  },
  deleteFile(path: string) {
    return ['rm', '--', path];
  },
  fileExists(path: string) {
    return ['test', '-e', path];
  },
  listDirectory(path: string) {
    return ['find', path, '-mindepth', '1', '-maxdepth', '1', '-printf', LIST_DIRECTORY_FORMAT];
  },
  startProcess(processId: string, command: string) {
    return ['sh', '-c', START_PROCESS_SCRIPT, 'sh', processId, command];
  },
  processStatus(pid: string, processId: string) {
    return ['sh', '-c', PROCESS_STATUS_SCRIPT, 'sh', pid, `${PROCESS_DIR}/${processId}/exit`];
  },
  stopProcess(pid: string, graceTenths: number) {
    return ['sh', '-c', STOP_PROCESS_SCRIPT, 'sh', pid, String(graceTenths)];
  },
} as const;

/** Parses one `find -printf` line into its parts; `undefined` for malformed lines. */
export function parseListLine(
  line: string,
): { readonly typeLetter: string; readonly size: number; readonly name: string } | undefined {
  const parts = line.split('\t');
  if (parts.length < 3) return undefined;
  const [typeLetter, sizeText, ...rest] = parts;
  const size = Number(sizeText);
  if (typeLetter === undefined || Number.isNaN(size)) return undefined;
  return { typeLetter, size, name: rest.join('\t') };
}
