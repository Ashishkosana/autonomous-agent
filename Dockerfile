# Hugging Face Docker Space and Railway. This is the server image, not the
# disposable sandbox image in sandbox/local-linux/Dockerfile.
#
# One Node process. No nested Docker daemon. The agent runs inside this
# container (SpaceProcessEnvironment). PORT defaults to 7860; Railway overrides it.
# Do not bake secrets into the image. Set AGENT_MODEL_*, AGENT_EMBEDDING_*,
# and DATABASE_URL in the host's secret store.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV PORT=7860
EXPOSE 7860
CMD ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", "./scripts/register-ts.mjs", "spaces/huggingface/server.ts"]
