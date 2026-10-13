#!/usr/bin/env python3
"""
BEAM context assembly transform (scripts/eval/beam/assemble-sessions.py).

Maps chunk-level retrieval hits to full session files from the BEAM adapter corpus,
one hit per session (dedup, first/highest-rank occurrence wins), preserving hit
order and scores. Context assembly in the QA harness then caps the
rendered session excerpts at --max-context-tokens.
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
    parser = argparse.ArgumentParser(description="Map chunk-level retrieval hits to full session markdown")
    parser.add_argument('--run', required=True, help='source retrieval dir (cases.jsonl + results.jsonl + manifest.json)')
    parser.add_argument('--output', required=True, help='transformed retrieval dir to write')
    args = parser.parse_args()

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

    cases = read_jsonl(cases_path)
    corpus_dirs = sorted({c.get('corpusDir') for c in cases if c.get('corpusDir')})
    if not corpus_dirs:
        corpus_dirs = list(source_manifest.get('corpusDirs') or [])

    sessions = {}
    for corpus_dir in corpus_dirs:
        sessions_dir = os.path.join(corpus_dir, 'Sessions')
        if not os.path.isdir(sessions_dir):
            sys.exit(f'corpus dir has no Sessions/: {corpus_dir}')
        for name in sorted(os.listdir(sessions_dir)):
            if not name.endswith('.md'):
                continue
            if name in sessions:
                sys.exit(f'duplicate session filename across corpora: {name}')
            with open(os.path.join(sessions_dir, name), 'r', encoding='utf-8') as fh:
                sessions[name] = fh.read()

    results = read_jsonl(results_path)
    per_case = []
    out_lines = []
    hits_out = dropped_duplicate = dropped_unmapped = 0
    for row in results:
        session_seen = set()
        new_hits = []
        case_dropped_duplicate = 0
        case_dropped_unmapped = 0
        for hit in row.get('hits', []):
            note_path = hit.get('notePath') or ''
            filename = os.path.basename(note_path)
            canonical = re.sub(r'-occ\d+\.md$', '.md', filename)
            if canonical in session_seen:
                dropped_duplicate += 1
                case_dropped_duplicate += 1
                continue
            text = sessions.get(canonical)
            if text is None:
                dropped_unmapped += 1
                case_dropped_unmapped += 1
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
            'droppedDuplicate': case_dropped_duplicate,
            'droppedUnmapped': case_dropped_unmapped,
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
    with open(os.path.join(out_dir, 'per-case.jsonl'), 'w', encoding='utf-8') as fh:
        for row in per_case:
            fh.write(json.dumps(row) + '\n')

    def sha256_file(p):
        with open(p, 'rb') as fh:
            return hashlib.sha256(fh.read()).hexdigest()

    manifest = {
        'schemaVersion': 1,
        'benchmark': source_manifest.get('benchmark', 'beam-retrieval'),
        'metricProtocol': 'beam-session-level-context-assembly',
        'transform': {
            'kind': 'session-level-context-assembly',
            'source': run_dir,
            'sourceResultsSha256': sha256_file(results_path),
            'rule': 'each hit notePath -> FULL adapter session file text; one hit per canonical session; order and scores preserved',
            'goldBlind': True,
        },
        'corpusDirs': corpus_dirs,
        'sessionsMapped': len(sessions),
        'hitsRendered': hits_out,
        'hitsDropped': dropped_duplicate + dropped_unmapped,
        'hitsDroppedDuplicate': dropped_duplicate,
        'hitsDroppedUnmapped': dropped_unmapped,
        'casesTotal': len(out_lines),
        'sourceManifest': source_manifest,
        'resultsSha256': sha256_file(os.path.join(out_dir, 'results.jsonl')),
        'perCaseSha256': sha256_file(os.path.join(out_dir, 'per-case.jsonl')),
    }
    with open(os.path.join(out_dir, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2)
        fh.write('\n')
    print(json.dumps({k: manifest[k] for k in (
        'sessionsMapped', 'hitsRendered', 'hitsDropped', 'hitsDroppedDuplicate', 'hitsDroppedUnmapped', 'casesTotal'
    )}))

if __name__ == '__main__':
    main()
