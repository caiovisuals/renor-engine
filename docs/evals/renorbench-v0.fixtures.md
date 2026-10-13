# RenorBench v0 synthetic fixture

Use synthetic data only. The starter dev cases assume a fictional subject, **Ava Morgan**, so failures cannot be patched by adding Patrick-specific query cues.

Suggested event sequence:

1. Ava says her favorite drink is mango juice.
2. Ava lives in Boston.
3. Ava is interested in piano recordings, violin concerts, and classical composers.
4. Ava says she is learning cello.
5. Later, Ava corrects her favorite drink to passion fruit juice.
6. Later, Ava moves from Boston to Seattle.
7. Add at least 20 unrelated but semantically adjacent distractor memories.

Important properties:
- Preserve superseded information so historical questions remain answerable.
- Mark or represent current state so current-state questions favor the latest valid fact.
- Do not include any passport number.
- Keep fixture construction deterministic.

This fixture is intentionally small. It is a smoke benchmark, not the held-out RenorBench test set.
