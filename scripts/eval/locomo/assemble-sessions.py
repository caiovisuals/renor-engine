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

Two opt-in options (both unset by default; with neither, every output file is
byte-identical to the version before them):

  --corpus-from PATH   a cases.jsonl (or a directory holding one) whose corpusDir
                       entries supply the session text, so a run retrieved on one
                       corpus can be assembled from another (for example the
                       corpus built with build-corpus.py --image-turns caption).
                       Retrieval order and scores are still the run's own.
  --window N           instead of the FULL session, emit the turns the session's
                       chunk hits matched plus/minus N turns on each side, in
                       order, with a line "[...]" where turns are left out. The
                       matched turns are read from the "### Turn K" headings of
                       the run's own chunk hits: gold-blind, no new retrieval.
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

TURN_HEAD_RE = re.compile(r'(?m)^### Turn (\d+) — ')
GAP_LINE = '[...]'


def split_turns(text):
    """Split a session file into its header and its turn blocks: [(turn_no, exact block text)]."""
    heads = list(TURN_HEAD_RE.finditer(text))
    blocks = []
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        blocks.append((int(m.group(1)), text[m.start():end].rstrip('\n')))
    return blocks


def window_text(blocks, matched, radius):
    """Matched turns plus/minus `radius` blocks, in file order; GAP_LINE between runs that are not adjacent.

    Returns None when no block was matched (every chunk hit of the session was a header-only chunk)."""
    index = {no: i for i, (no, _) in enumerate(blocks)}
    keep = set()
    for no in matched:
        i = index.get(no)
        if i is None:
            continue
        keep.update(range(max(0, i - radius), min(len(blocks), i + radius + 1)))
    if not keep:
        return None
    parts = []
    previous = None
    for i in sorted(keep):
        if previous is not None and i != previous + 1:
            parts.append(GAP_LINE)
        parts.append(blocks[i][1])
        previous = i
    return '\n\n'.join(parts)


def read_corpus_dirs(cases_path_or_dir):
    path = cases_path_or_dir
    if os.path.isdir(path):
        path = os.path.join(path, 'cases.jsonl')
    return sorted({c.get('corpusDir') for c in read_jsonl(path) if c.get('corpusDir')})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', required=True, help='source retrieval dir (cases.jsonl + results.jsonl + manifest.json)')
    ap.add_argument('--output', required=True, help='transformed retrieval dir to write')
    ap.add_argument('--corpus-from', default=None,
                    help='cases.jsonl (or a directory holding one) whose corpusDir entries supply the session text '
                         '(default: the --run directory\'s own cases.jsonl)')
    ap.add_argument('--window', type=int, default=None, metavar='N',
                    help='emit the matched turns plus/minus N turns instead of the full session (default: full session)')
    args = ap.parse_args()
    if args.window is not None and args.window < 0:
        sys.exit('--window must be 0 or more')

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
    if args.corpus_from:
        corpus_dirs = read_corpus_dirs(os.path.abspath(args.corpus_from))
    else:
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
    header_only_skipped = 0
    for row in results:
        session_seen = set()
        new_hits = []
        matched_by_session = {}
        if args.window is not None:
            # Turns each session's chunk hits matched (one chunk = one "### Turn K" block in this corpus).
            for hit in row.get('hits', []):
                matched_key = re.sub(r'-occ\d+\.md$', '.md', os.path.basename(hit.get('notePath') or ''))
                matched_by_session.setdefault(matched_key, set()).update(
                    int(no) for no in TURN_HEAD_RE.findall(hit.get('text') or ''))
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
            if args.window is not None:
                windowed = window_text(split_turns(text), matched_by_session.get(canonical, ()), args.window)
                if windowed is None:
                    header_only_skipped += 1  # every chunk hit of this session was a header-only chunk
                    continue
                text = windowed
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
    if args.window is not None:
        manifest['transform'].update({
            'kind': 'session-window-context-assembly',
            'rule': f'each hit notePath -> the turns that session\'s chunk hits matched plus/minus {args.window} turns of the adapter session file, in file order, "{GAP_LINE}" where turns are left out; one hit per canonical session (first occurrence); hit order + scores preserved; sessions whose chunk hits are all header-only are left out',
            'windowTurns': args.window,
            'headerOnlySessionsSkipped': header_only_skipped,
        })
    if args.corpus_from:
        manifest['transform']['corpusFrom'] = os.path.abspath(args.corpus_from)
    with open(os.path.join(out_dir, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2)
        fh.write('\n')
    print(json.dumps({k: manifest[k] for k in ('sessionsMapped', 'hitsRendered', 'hitsDropped', 'casesTotal')}))


if __name__ == '__main__':
    main()