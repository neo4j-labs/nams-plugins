FROM node:24-bookworm-slim

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates bash \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @openai/codex

CMD ["sleep", "infinity"]
