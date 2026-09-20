/**
 * Limits shared by every standard tool. Chosen at the composition root, not
 * by the model: a proposal may ask for a shorter timeout, never a longer one.
 */
export interface ToolOptions {
  /** Absolute POSIX path of the sandbox workspace; all file paths resolve under it. */
  readonly workspaceRoot: string;
  /** Upper bound on characters of any single text field returned to the model. */
  readonly maxOutputChars: number;
  /** Applied when a proposal does not specify a timeout. */
  readonly defaultTimeoutMs: number;
  /** Hard ceiling for any proposed timeout. */
  readonly maxTimeoutMs: number;
  /** Directory (under the workspace) where tools stage their own scratch files. */
  readonly scratchDir: string;
}

export const DEFAULT_TOOL_OPTIONS: ToolOptions = {
  workspaceRoot: '/workspace',
  maxOutputChars: 16_000,
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 300_000,
  scratchDir: '.agent',
};

export function resolveToolOptions(overrides: Partial<ToolOptions> = {}): ToolOptions {
  return { ...DEFAULT_TOOL_OPTIONS, ...overrides };
}

/** Clamp a model-proposed timeout into [1s, max]; undefined means the default. */
export function clampTimeout(options: ToolOptions, proposed: number | undefined): number {
  if (proposed === undefined) return options.defaultTimeoutMs;
  return Math.min(options.maxTimeoutMs, Math.max(1_000, Math.floor(proposed)));
}
