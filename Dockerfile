# Renor stdio MCP server (renor-engine). Node 22 is required (native modules).
FROM node:22-bookworm-slim

# Toolchain fallback in case a prebuilt better-sqlite3 binary is not available.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci \
 && npm rebuild better-sqlite3 --ignore-scripts=false

# Copy only what the build reads. A bare `COPY . .` would bake the builder's local files into the image:
# .env.local, credentials, keys, a local vault or SQLite state. The build needs tsconfig.json, src/ and the stamp script.
COPY tsconfig.json ./
COPY src ./src
COPY scripts/ci/stamp-build.mjs ./scripts/ci/stamp-build.mjs

# The build stamps a commit id. Without .git it needs one; this value only labels dist/BUILD.json.
ARG RENOR_BUILD_COMMIT=0000000
ENV RENOR_BUILD_COMMIT=${RENOR_BUILD_COMMIT}
RUN npm run build

# Offline demo configuration: no model download, no API key, no telemetry.
ENV VAULT_PATH=/app/demo-vault \
    EMBEDDING_PROVIDER=eval-hash \
    RENOR_EVIDENCE_MODE=off \
    RENOR_TELEMETRY_DISABLED=true

# One-note demo vault, indexed at build time so the server starts without printing migration lines on stdout.
RUN mkdir -p "$VAULT_PATH" \
 && printf '%s\n' 'The blue notebook is on the desk.' > "$VAULT_PATH/notebook.md" \
 && node dist/cli.js index

# stdio MCP server; stdout is the protocol channel.
CMD ["node", "dist/cli.js", "mcp"]
