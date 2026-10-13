# CONTEXT.md — Project Glossary

The memory system: durable personal memory for AI agents. The Vault is the Brain.

## Terms

- **The Vault** — the git-tracked Obsidian vault. Source of truth for everything: notes, facts, history. Human-readable markdown. Portable forever (the anti-walled-garden position).
- **The Brain** — the disposable semantic index (SQLite + FTS + vectors) built *from* the Vault. Rebuildable at any time from Vault + Ledger. Never authoritative.
- **The Ledger** — `System/Memory Events Ledger.md`, append-only record of memory events (store/supersede). Replayed on rebuild; survives index deletion.
- **Memory Event** — one durable write: subject + predicate + object + timestamp (+ source). Facts supersede, never overwrite: old value gets `valid_to`, history stays queryable.
- **Backfill** — retrospective memory creation: ingest existing conversation history (ChatGPT export), extract summaries + facts, write into the Vault. The answer to cold-start: memory born retrospectively, not day-one-empty.
- **Extraction** — the compressive pass that turns raw conversation into memory: narrative summary note + structured facts. Lossy by design (~2% of raw); the vault of record stays small.
- **Quarantine** — imported material lands in a separate area (`ChatGPT History/`), never mixed into canonical notes until reviewed.
- **Promotion** — the later curation pass that moves quarantined material into canonical structure once proven valuable.
- **Cascade** — extraction model strategy: cheap model runs everything; low-confidence/complex cases escalate to a stronger model.

## Terms (retrieval round, 2026-09-08)

- **Retrieval slots** — the scarce resource: the top ~5-20 chunks an agent actually reads. Every indexed chunk competes for them. Storage is cheap; attention is not.
- **Store vs. Index** — the vault stores broadly (everything, forever, cheap); the brain indexes narrowly (curated layers only). Raw source material lives as files, never as retrieval surface.
- **The three layers** — Facts (ledger, superseded, first-class retrieval) / Narrative (dated summaries and history, searchable) / Archive (raw source, stored unindexed for provenance and future re-extraction).
- **Decision test** — the storage/index question for any item: "would any future decision change if this were missing?"
- **By-output-type cascade** — facts extracted with the strong model (GLM 5.3), summaries with the cheap model (GLM 5.3 Flash). Precision where it's durable, economy where it's voluminous.
