# Server entrypoint

`server.ts` is a composition root for Railway and a Hugging Face Docker Space.
It reads the environment and passes the values into the existing runtime.
`src/` does not read `process.env`. `app.ts` is the HTTP surface: `/health`,
`/`, `/api/run`, `/api/compare`, and `/api/memory`.

The page on `PORT` (default 7860) runs one goal, streams events, and compares
the two latest stored runs of that same goal. The default goal fetches
`https://example.com` and writes a lesson file. Learning on the page means
durable memory. It does not fine-tune model weights.

## Execution limit

This process uses `SpaceProcessEnvironment`. Commands run in this container.
There is no nested Docker daemon, so the local-linux sandbox and the Cloudflare
sandbox are not started here. Those paths stay on the CLI and the Worker.

Shell commands do not inherit the process environment, so they cannot print
`DATABASE_URL`. They can still read other files in the container, including
`/proc`. Do not put secrets in the image. Prefer a private Space.

## Secrets

Set these in the host, not in the repository:

- `AGENT_MODEL_PROVIDER=openai-compatible`
- `AGENT_MODEL_BASE_URL=https://api.groq.com/openai/v1`
- `AGENT_MODEL_NAME=llama-3.3-70b-versatile`
- `AGENT_MODEL_LABEL=groq`
- `AGENT_MODEL_API_KEY`
- `AGENT_EMBEDDING_*` (optional; unset means lexical retrieval)
- `DATABASE_URL` or `NEON_DATABASE_URL` (Neon). If none is set, memory is a SQLite file under `/tmp` and disappears when the container sleeps or restarts.

`GET /health` pings that database. A failed ping returns 503 and does not include the connection string.
