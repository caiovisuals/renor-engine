#!/usr/bin/env python3
"""
LoCoMo context assembly transform (scripts/eval/locomo/assemble-sessions.py).

Replaces turn-level retrieval excerpts with FULL Renor session files.

The retrieval unit in this benchmark is the Renor memory note (a session
file). Retrieval hits are turn-level chunks of those notes; the diagnosed
failure mode is chunk starvation: the gold turn is absent from the rendered
top-20 excerpt text even when the gold session ranks in the top-20. This
transform removes that confound the same way the product does: each hit's
notePath is mapped to the FULL session markdown from the adapter corpus, one
hit per session (dedup, first/highest-rank occurrence wins), preserving hit
order and scores. Context assembly in the frozen QA harness then caps the
rendered session excerpts at --max-context-tokens (6000).

Deterministic and gold-blind: session text comes from adapter/corpus only;
scores/order come from the frozen retrieval run; no gold answers, no
re-embedding, no re-retrieval.
"""
import argparse
import hashlib
import json
import os
import re
import sys


def read_jsonl(path):
    with open(path, 'r', encoding='utf-8') as fh:
        return [json.loads(line) for line in fh if line.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', required=True, help='source retrieval dir (cases.jsonl + results.jsonl + manifest.json)')
    ap.add_argument('--output', required=True, help='transformed retrieval dir to write')
    args = ap.parse_args()

    run_dir = os.path.abspath(args.run)
    out_dir = os.path.abspath(args.output)
    cases_path = os.path.join(run_dir, 'cases.jsonl')
    results_path = os.path.join(run_dir, 'results.jsonl')
    manifest_path = os.path.join(run_dir, 'manifest.json')
    for p in (cases_path, results_path, manifest_path):
        if not os.path.isfile(p):
            sys.exit(f'missing required input: {p}')

    with open(manifest_path, 'r', encoding='utf-8') as fh:
        source_manifest = json.load(fh)
    # The adapter records one corpus dir per conversation in cases.jsonl; build
    # a notePath -> full-session-text map directly from those corpus dirs.
    cases = read_jsonl(cases_path)
    corpus_dirs = sorted({c.get('corpusDir') for c in cases if c.get('corpusDir')})
    if not corpus_dirs:
        # Fall back to the manifest's corpusDirs.
        corpus_dirs = list(source_manifest.get('corpusDirs') or [])

    sessions = {}
    for corpus_dir in corpus_dirs:
        sessions_dir = os.path.join(corpus_dir, 'Sessions')
        if not os.path.isdir(sessions_dir):
            sys.exit(f'corpus dir has no Sessions/: {corpus_dir}')
        for name in sorted(os.listdir(sessions_dir)):
            if not name.endswith('.md'):
                continue
            # Bare session filename (loco-conv-NN-sN-hash.md) is the join key.
            if name in sessions:
                sys.exit(f'duplicate session filename across corpora: {name}')
            with open(os.path.join(sessions_dir, name), 'r', encoding='utf-8') as fh:
                sessions[name] = fh.read()
    if not sessions:
        sys.exit('no session files found in any corpus dir')

    results = read_jsonl(results_path)
    per_case = []
    out_lines = []
    hits_out = dropped = 0
    for row in results:
        session_seen = set()
        new_hits = []
        for hit in row.get('hits', []):
            note_path = hit.get('notePath') or ''
            filename = os.path.basename(note_path)
            # Canonical session key strips any -occN suffix (kept for parity
            # with the harness's canonicalSegment rule).
            canonical = re.sub(r'-occ\d+\.md$', '.md', filename)
            if canonical in session_seen:
                dropped += 1
                continue
            text = sessions.get(canonical)
            if text is None:
                dropped += 1
                continue
            session_seen.add(canonical)
            new_hits.append({
                'text': text.rstrip('\n'),
                'notePath': hit['notePath'],
                'score': hit['score'],
            })
            hits_out += 1
        per_case.append({
            'id': row['id'],
            'originalHits': len(row.get('hits', [])),
            'sessionHits': len(new_hits),
            'droppedUnmapped': 0,  # replaced below after join check
        })
        out_lines.append(json.dumps({
            'id': row['id'],
            'hits': new_hits,
            'latencyMs': row.get('latencyMs'),
            'contextTokens': row.get('contextTokens'),
            'topK': row.get('topK'),
        }))
        if not new_hits:
            sys.exit(f'question {row["id"]} lost all hits in transform')

    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, 'results.jsonl'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(out_lines) + '\n')
    for name in ('cases.jsonl',):
        with open(os.path.join(run_dir, name), 'rb') as src, open(os.path.join(out_dir, name), 'wb') as dst:
            dst.write(src.read())
    # per-case summary
    with open(os.path.join(out_dir, 'per-case.jsonl'), 'w', encoding='utf-8') as fh:
        for row in per_case:
            fh.write(json.dumps(row) + '\n')

    def sha256_file(p):
        with open(p, 'rb') as fh:
            return hashlib.sha256(fh.read()).hexdigest()

    manifest = {
        'schemaVersion': 1,
        'benchmark': source_manifest.get('benchmark', 'locomo10-retrieval'),
        'metricProtocol': 'renor-chunk-to-evidence-session-v1-not-official',
        'transform': {
            'kind': 'session-level-context-assembly',
            'source': run_dir,
            'sourceResultsSha256': sha256_file(results_path),
            'rule': 'each hit notePath -> FULL adapter session file text; one hit per canonical session (dedup first occurrence); hit order + scores preserved; token cap applied downstream by frozen QA harness (--max-context-tokens 6000)',
            'goldBlind': True,
            'noReEmbedding': True,
            'noReRetrieval': True,
        },
        'corpusDirs': corpus_dirs,
        'sessionsMapped': len(sessions),
        'hitsRendered': hits_out,
        'hitsDropped': dropped,
        'casesTotal': len(out_lines),
        'sourceManifest': {k: source_manifest.get(k) for k in (
            'provider', 'topK', 'chunking', 'resultsSha256', 'perCaseSha256',
            'gitSha', 'evaluatorSha256', 'datasetSha256')},
        'resultsSha256': sha256_file(os.path.join(out_dir, 'results.jsonl')),
        'perCaseSha256': sha256_file(os.path.join(out_dir, 'per-case.jsonl')),
    }
    with open(os.path.join(out_dir, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2)
        fh.write('\n')
    print(json.dumps({k: manifest[k] for k in ('sessionsMapped', 'hitsRendered', 'hitsDropped', 'casesTotal')}))


if __name__ == '__main__':
    main()