# syntax=docker/dockerfile:1
#
# Local development sandbox for the autonomous agent (ADR-002).
#
# Small, reproducible Debian image with the runtimes the agent's tools need:
# POSIX sh + bash, GNU coreutils/findutils/procps (used by the adapter's
# scripts), git, curl, Node.js 22 and Python 3 (Debian bookworm, 3.11).
# No Docker client, no cloud CLIs, no credentials. Runs as a non-root user.
#
# Build:   npm run sandbox:build   (→ agent-sandbox-local:0.1.0)
# The version here, in src/sandbox/local/sandbox-spec.ts and package.json must match.

FROM node:22.23.2-bookworm-slim

LABEL org.opencontainers.image.title="agent-sandbox-local" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.description="Disposable Linux sandbox for the autonomous agent's local execution environment"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    npm_config_update_notifier=false

# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      jq \
      procps \
      python3 \
      python3-pip \
      python3-venv \
      unzip \
 && rm -rf /var/lib/apt/lists/*

# Dedicated non-root runtime user. Fixed uid/gid so ownership is predictable.
RUN groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash agent \
 && mkdir -p /workspace \
 && chown agent:agent /workspace

USER agent
WORKDIR /workspace
ENV HOME=/home/agent \
    PATH=/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# The container idles; every agent operation is a separate `exec`.
CMD ["sleep", "infinity"]
