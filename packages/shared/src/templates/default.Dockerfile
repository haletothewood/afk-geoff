FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  bash \
  ca-certificates \
  curl \
  git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
