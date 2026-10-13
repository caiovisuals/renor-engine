# Contributing

Thanks for helping improve `obsidian-semantic-memory`.

## Setup

```bash
git clone https://github.com/sterben-enec/obsidian-semantic-memory
cd obsidian-semantic-memory
cp .env.example .env
npm install
npm run build
npm test
```

Set `VAULT_PATH` in `.env` to a local test vault before running the CLI manually.

## Development workflow

- Keep changes focused and small
- Prefer adding tests with behavior changes
- Run `npm test` before opening a PR
- Update `README.md` / `README.ru.md` when public behavior changes
- Avoid committing personal vault paths, `.env`, databases, logs, or private notes

## Pull requests

Please include:

- what changed
- why it changed
- any migration or compatibility notes
- screenshots / logs only when they add signal

## Style

- TypeScript, CommonJS
- Keep the CLI and MCP surface explicit
- Prefer local-first and privacy-safe defaults
