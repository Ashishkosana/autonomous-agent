import { DEFAULT_CLI_LIMITS } from './limits.js';

const minutes = Math.round(DEFAULT_CLI_LIMITS.maxDurationMs / 60_000);

/**
 * Shown for `--help` and for usage errors. The model is not allowed to
 * declare the goal complete: only `DeterministicEvaluator` can, and only
 * from criteria the human supplied.
 */
export const AGENT_HELP = `autonomous-agent — run one goal through the existing agent runtime

Usage
  npm run agent -- "your goal" [criteria]
  npm run agent -- --help

The goal is the remaining text. Put it in quotes when it contains spaces.
Interactive prompting is not implemented.

This is a measurable memory-augmented autonomous agent with deterministic
evaluation and observability. It does not train the model. Foundation-model
weights stay external and fixed. Memory can be shown to a later run; that
is not evidence the agent learned.

Environment
  The CLI loads .env from the working directory when that file exists, and
  does not override variables already set in the shell. The API key is never
  printed.

  AGENT_MODEL_PROVIDER=openai-compatible
  AGENT_MODEL_BASE_URL=https://api.groq.com/openai/v1
  AGENT_MODEL_NAME=openai/gpt-oss-120b
  AGENT_MODEL_API_KEY=...

  AGENT_EMBEDDING_* is optional. Unset means retrieval is lexical only.
  AGENT_MEMORY_PATH overrides the memory file (default ./.agent/memory.sqlite).
  AGENT_MEMORY_BACKEND=sqlite is assumed when only the path is set.

Execution
  Every run uses the local Docker/Linux sandbox (image agent-sandbox-local).
  There is no fallback to the host. If Docker or the image is missing, the
  CLI exits. Build the image with: npm run sandbox:build
  /workspace is inside the container. The container is destroyed when the
  run finishes, is interrupted, or fails. Files there are not copied to the host.

Memory
  Records are written to the SQLite file above and kept after the process
  exits, so a later run can retrieve them. --memory off keeps those writes
  but installs SuppressedRetriever: the run does not read the store and does
  not embed the goal. Write-time indexing still embeds new records when an
  embedding endpoint is configured.

Success criteria
  The evaluator does not trust the model. A goal with no mechanical criterion
  ends inconclusive, not success. Pass criteria explicitly:

  --require-file <path>
      file must exist in the sandbox (file_exists)
  --require-marker <text>
      the preceding --require-file must contain this text (file_contains)
  --criterion <grammar>
      any production criterion, repeatable:
        file_exists:<path>
        file_contains:<path>|<marker>
        json_file:<path>
        json_file:<path>|<key>,<key>
        command_exits_zero:<command>
        http_status:<code>
        tool_succeeded
        tool_succeeded:<tool name>
  --constraint <text>   repeated; shown to the planner as a hard constraint
  --memory on|off       default on

Example
  npm run agent -- \\
    "Create /workspace/hello.txt containing exactly AGENT_ALIVE" \\
    --require-file /workspace/hello.txt \\
    --require-marker AGENT_ALIVE

Limits for one run
  iterations ${DEFAULT_CLI_LIMITS.maxIterations}, tool calls ${DEFAULT_CLI_LIMITS.maxToolCalls}, model calls ${DEFAULT_CLI_LIMITS.maxModelCalls},
  tokens ${DEFAULT_CLI_LIMITS.maxTotalTokens}, duration ${minutes} minutes

Exit codes
  0  evaluator confirmed completion
  1  configuration, Docker, or runtime error
  2  the run stopped (failure, give-up, or a limit)
  130  interrupted; the sandbox is destroyed
`;
