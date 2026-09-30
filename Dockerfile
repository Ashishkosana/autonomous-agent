# Hugging Face Docker Space. This is the Space image, not the disposable
# sandbox image in sandbox/local-linux/Dockerfile.
#
# A free Space has no Docker daemon, so the agent runs inside this container
# (SpaceProcessEnvironment). Do not bake secrets into the image. Set them as
# Space secrets: AGENT_MODEL_*, AGENT_EMBEDDING_*, and DATABASE_URL.
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
