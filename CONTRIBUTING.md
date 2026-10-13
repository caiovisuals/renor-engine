# Contributing to Renor

Thanks for looking. This is a single-owner memory engine, so the bar is simple: a change should make it work better for the person running it, and it should come with a test.

## Set up

Renor needs **Node 22** (`.nvmrc`, `mise.toml`). Native modules (`better-sqlite3`, `sqlite-vec`) are built for one Node major, so another version fails at `renor index` with `NODE_MODULE_VERSION`. The [README](README.md) has the exact fix.

```bash
nvm use                 # or: mise use node@22
export RENOR_BUILD_COMMIT="$(git rev-parse HEAD)"   # only needed without a git checkout
npm ci
npm rebuild better-sqlite3 --ignore-scripts=false   # only if npm skipped install scripts
npm run build
```

## Test

```bash
npx tsc --noEmit
npx tsc -p tsconfig.public-eval.json --noEmit
npm test -- --maxWorkers=2
npm run eval:renor:hash -- --output .eval-runs/hash-smoke
```

These are the same steps as `.github/workflows/engine-public-ci.yml`; the CI badge on `main` should be green before you open a pull request. Tests use the offline `eval-hash` embedding stub. Do not add a test that needs a paid model, a downloaded model or the network.

## Pull requests

- Open an issue first for anything larger than a bug fix, so we agree on the shape before you write it.
- Keep a pull request to one change. Say what it does, why, and which tests you ran.
- A bug fix needs a test that fails before the fix and passes after it.
- Say so in the description if the change loosens security (who can sign in, what a token can reach, what a tool returns) or changes retrieval results. Those get a closer review.
- Never commit credentials, real notes or personal paths. Test fixtures that look like secrets must be obviously synthetic and are allowlisted by exact path in `.gitleaks.toml`.
- Dependency updates come from Dependabot. `@modelcontextprotocol/sdk` minor and major bumps are held until `tests/mvp/schema-rejected-calls.test.ts` is reviewed against the new SDK.

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md). Do not open a public issue for them.

## License

By contributing you agree that your work is licensed under AGPL-3.0-only, the same as the project ([LICENSE](LICENSE)).
