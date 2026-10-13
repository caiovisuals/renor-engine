## What and why

<!-- One change. What it does, and why it is needed. -->

## Tests

<!-- Which tests you ran, and the result. A bug fix needs a test that fails before the fix and passes after it. -->

- [ ] `npx tsc --noEmit` and `npm test` pass
- [ ] A bug fix has a regression test that fails on the old code

## Review flags

- [ ] This loosens security (who can sign in, what a token can reach, what a tool returns). Say how below, or leave unchecked if not.
- [ ] This changes retrieval results. Include before and after numbers, with the eval run that produced them.

## Checks

- [ ] No credentials, real notes, or personal paths in the diff
- [ ] Test fixtures that look like secrets are synthetic and listed by exact path in `.gitleaks.toml`
