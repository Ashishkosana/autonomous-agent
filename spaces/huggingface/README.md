# Hugging Face Space entrypoint

`server.ts` is a composition root. It reads the environment and passes the
values into the existing runtime. `src/` does not read `process.env`.

The page on port 7860 accepts one goal and mechanical criteria, then streams
agent events as server-sent events. The default goal is the `AGENT_ALIVE`
file check. The internet-learning experiment is documented in the root README
and in `docs/experiments.md` (E-010); paste that goal if you want to run it.

## Execution limit

This process uses `SpaceProcessEnvironment`. Commands run in the Space
container. A free Space has no Docker daemon, so the local-linux sandbox and
the Cloudflare sandbox are not started here. Those paths stay on the CLI and
the Worker.

Shell commands do not inherit the process environment, so they cannot print
`DATABASE_URL`. They can still read other files in the container, including
`/proc`. Do not put secrets in the image. Prefer a private Space.

## Secrets

Set these in the Space settings, not in the repository:

- `AGENT_MODEL_PROVIDER`, `AGENT_MODEL_BASE_URL`, `AGENT_MODEL_NAME`, `AGENT_MODEL_API_KEY`
- `AGENT_EMBEDDING_PROVIDER`, `AGENT_EMBEDDING_BASE_URL`, `AGENT_EMBEDDING_MODEL`, `AGENT_EMBEDDING_API_KEY` (optional; unset means lexical retrieval)
- `DATABASE_URL` or `NEON_DATABASE_URL` (Neon). If none is set, memory is a SQLite file under `/tmp` and disappears when the Space sleeps or restarts.

`PORT` is set by the Space (7860). The server listens on it.
