FROM ghcr.io/openai/codex-universal:latest

SHELL ["/bin/bash", "-lc"]

WORKDIR /workspace

RUN npm install -g @openai/codex \
  && ln -sf "$(command -v node)" /usr/local/bin/node \
  && ln -sf "$(command -v npm)" /usr/local/bin/npm \
  && ln -sf "$(command -v codex)" /usr/local/bin/codex \
  && node --version \
  && npm --version \
  && codex --version
