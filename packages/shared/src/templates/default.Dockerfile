FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  bash \
  ca-certificates \
  curl \
  git \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && npm install -g @anthropic-ai/claude-code

WORKDIR /workspace
