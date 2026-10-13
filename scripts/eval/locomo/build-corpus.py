#!/usr/bin/env python3
"""
Renor-on-LoCoMo adapter (campaign objective 3 — second public memory benchmark).

Converts each LoCoMo conversation (snap-research/LoCoMo, CC BY-NC 4.0) into
Renor-style session files mirroring scripts/eval/run-longmemeval.ts
renderSession(), then emits the artifacts the frozen QA harness
(scripts/eval/run-longmemeval-qa.ts) consumes:

  <out>/corpus/conv-<NN>/Sessions/<segment>.md   one file per session_N
  <out>/cases.jsonl                              retrieval cases (frozen schema)
  <out>/locomo-dataset.json                      LongMemEval row shape
                                                 {question_id, question_date,
                                                  haystack_session_ids,
                                                  haystack_dates}
                                                 — feeds --recency-order's
                                                 dateMap in the frozen QA
                                                 runner, which stays unmodified.
  <out>/adapter-meta.json                        counts + data-quality notes

Protocol (mirrors the LongMemEval harness byte-for-byte where applicable):
- session file format: '---\\nkind: longmemeval-session\\nsession_id: "..."' +
  '# Session <id>\\n\\nTimestamp: <date>\\n\\n### Turn <i> — <Speaker>\\n\\n<text>'
  Turn index = the turn number from dia_id ('D<sess>:<turn>'), so gold
  evidence refs stay exact. Multimodal/image turns (img_url/blip_caption) are
  SKIPPED (text-only baseline); the count is recorded and their session-level
  gold mapping survives because gold is mapped by dia_id session prefix.
- gold evidence mapping: dia_id 'D<sess>:<turn>' -> session id (session-level
  recall) + exact turn (turn-level bonus metric). Unparseable evidence refs
  ('D', 'D:11:26') are dropped from the gold mapping and recorded.
- question date: LoCoMo QA annotations carry no question timestamp; the last
  session date of the conversation is used (documented choice).
- expectedAnswer (judge gold): qa.answer when present, else
  qa.adversarial_answer (category 5 keeps its adversarial gold so abstention
  behaviour is scored against the probe's intended answer).
- LoCoMo dates '1:56 pm on 8 May, 2023' are converted to the LongMemEval
  timestamp format '2023/05/08 (Mon) 13:56' so Renor's parseTimestamp and the
  recency clock work unmodified.
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
import re
import sys

MONTHS = {mn: i + 1 for i, mn in enumerate(
    'January February March April May June July August September October November December'.split())}
DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
CATEGORY_NAMES = {1: 'single-hop', 2: 'multi-hop', 3: 'temporal', 4: 'open-domain', 5: 'adversarial'}

DATE_RE = re.compile(r'^(\d+):(\d+) (am|pm) on (\d+) (\w+), (\d{4})$')
TURN_RE = re.compile(r'^D(\d+):(\d+)$')


def parse_locomo_date(value: str) -> datetime.datetime:
    m = DATE_RE.match(value.strip())
    if not m:
        raise ValueError(f'Unparseable LoCoMo date_time: {value!r}')
    hh = int(m.group(1)) % 12 + (12 if m.group(3) == 'pm' else 0)
    month = MONTHS[m.group(5)]
    return datetime.datetime(int(m.group(6)), month, int(m.group(4)), hh, int(m.group(2)))


def to_lme_date(value: str) -> str:
    dt = parse_locomo_date(value)
    return f"{dt.year}/{dt.month:02d}/{dt.day:02d} ({DOW[dt.weekday()]}) {dt.hour:02d}:{dt.minute:02d}"


def safe_segment(value: str) -> str:
    """Byte-identical to scripts/eval/run-longmemeval.ts safeSegment()."""
    normalized = re.sub(r'[^a-zA-Z0-9._-]+', '_', value).strip('_')
    prefix = normalized[:100] or 'session'
    digest = hashlib.sha256(value.encode('utf-8')).hexdigest()[:10]
    return f'{prefix}-{digest}'


def render_session(session_id: str, lme_date: str, turns: list) -> str:
    body = '\n\n'.join(
        f'### Turn {turn_no} — {speaker}\n\n{text}' for turn_no, speaker, text in turns
    )
    return (
        f'---\nkind: longmemeval-session\n'
        f'session_id: {json.dumps(session_id)}\n'
        f'session_date: {json.dumps(lme_date)}\n'
        f'---\n# Session {session_id}\n\nTimestamp: {lme_date}\n\n{body}\n'
    )


def parse_evidence(evidence: list) -> tuple:
    """Return (gold_refs, dropped_refs). gold_refs = [(session_no, turn_no)]."""
    gold, dropped = [], []
    for entry in evidence:
        found = False
        for m in re.finditer(r'D(\d+):(\d+)', str(entry)):
            gold.append((int(m.group(1)), int(m.group(2))))
            found = True
        if not found:
            dropped.append(str(entry))
    return gold, dropped


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--dataset', required=True, help='path to locomo10.json')
    ap.add_argument('--output', required=True, help='output directory')
    args = ap.parse_args()

    with open(args.dataset, 'r', encoding='utf-8') as fh:
        data = json.load(fh)

    dataset_sha = hashlib.sha256(open(args.dataset, 'rb').read()).hexdigest()
    out = os.path.abspath(args.output)
    os.makedirs(out, exist_ok=True)

    cases, dataset_rows, corpus_dirs = [], [], []
    meta = {
        'conversations': len(data),
        'sessions': 0,
        'turns_total': 0,
        'turns_rendered': 0,
        'image_turns_skipped': 0,
        'qa_total': 0,
        'evidence_refs_total': 0,
        'evidence_refs_unparseable_dropped': 0,
        'questions_without_evidence_sessions': 0,
        'turn_text_truncated_note': 'turn-level fingerprint = first 48 normalized chars of the turn text',
    }
    per_conv = {}

    for conv_idx, conv_obj in enumerate(data):
        sample_id = conv_obj.get('sample_id', f'conv-{conv_idx}')
        conv = conv_obj['conversation']
        speakers = {conv.get('speaker_a'), conv.get('speaker_b')}

        session_nos = sorted(
            int(m.group(1)) for k in conv
            if (m := re.fullmatch(r'session_(\d+)', k))
        )
        # sessions are chronological (verified monotonic); date per session
        sess_dates, sess_turns = {}, {}
        image_skipped = 0
        for n in session_nos:
            date_raw = conv.get(f'session_{n}_date_time')
            if not date_raw:
                raise ValueError(f'{sample_id}: missing session_{n}_date_time')
            sess_dates[n] = to_lme_date(date_raw)
            turns = []
            for turn in conv[f'session_{n}']:
                meta['turns_total'] += 1
                if 'img_url' in turn or 'blip_caption' in turn:
                    image_skipped += 1
                    meta['image_turns_skipped'] += 1
                    continue  # multimodal turn — text-only protocol skips it
                m = TURN_RE.match(turn['dia_id'])
                if not m or int(m.group(1)) != n:
                    raise ValueError(f'{sample_id}: bad dia_id {turn["dia_id"]} in session {n}')
                text = turn.get('text', '')
                if not text.strip():
                    image_skipped += 1  # empty non-textual placeholder
                    meta['image_turns_skipped'] += 1
                    continue
                speaker = turn.get('speaker') or '?'
                sess_turns.setdefault(n, []).append((int(m.group(2)), speaker, text))
            meta['turns_rendered'] += len(sess_turns.get(n, []))

        # write session files
        corpus_dir = os.path.join(out, 'corpus', f'conv-{conv_idx:02d}-{re.sub(r"[^a-zA-Z0-9._-]", "", sample_id)}')
        sessions_dir = os.path.join(corpus_dir, 'Sessions')
        os.makedirs(sessions_dir, exist_ok=True)
        session_ids = {}
        for n in session_nos:
            session_id = f'loco-{sample_id}-s{n}'
            session_ids[n] = session_id
            lme_date = sess_dates[n]
            segment = safe_segment(session_id)
            rel_path = f'Sessions/{segment}.md'
            full = os.path.join(corpus_dir, rel_path)
            with open(full, 'w', encoding='utf-8') as fh:
                fh.write(render_session(session_id, lme_date, sess_turns.get(n, [])))
            ts = parse_locomo_date(conv[f'session_{n}_date_time']).timestamp()
            os.utime(full, (ts, ts))  # mirror run-longmemeval.ts utimes
            meta['sessions'] += 1
        corpus_dirs.append(corpus_dir)

        last_date = sess_dates[max(session_nos)]

        # QA cases
        conv_stats = {'qa': 0, 'gold_sessions_zero': 0, 'dropped_refs': 0}
        for qa_idx, qa in enumerate(conv_obj['qa']):
            meta['qa_total'] += 1
            conv_stats['qa'] += 1
            question = qa['question']
            category = qa['category']
            gold, dropped = parse_evidence(qa.get('evidence', []))
            meta['evidence_refs_total'] += len(qa.get('evidence', []))
            conv_stats['dropped_refs'] += len(dropped)
            meta['evidence_refs_unparseable_dropped'] += len(dropped)
            gold_sessions = sorted({s for s, _ in gold})
            if not gold_sessions:
                conv_stats['gold_sessions_zero'] += 1
                meta['questions_without_evidence_sessions'] += 1

            # turn fingerprints for the turn-level bonus metric
            turn_texts = {}
            for s in gold_sessions:
                for turn_no, speaker, text in sess_turns.get(s, []):
                    turn_texts[(s, turn_no)] = text

            relevant = []
            for s in gold_sessions:
                sid = session_ids[s]
                segment = safe_segment(sid)
                relevant.append({
                    'match': segment,
                    'notePath': f'Sessions/{segment}.md',
                    'relevance': 1,
                    'role': 'positive',
                    'sessionNo': s,
                })
            turn_fp = []
            for (s, t) in gold:
                text = turn_texts.get((s, t))
                if text is None:
                    continue  # turn skipped (image turn) or beyond session end (dataset noise)
                norm = re.sub(r'\s+', ' ', text).strip().lower()[:48]
                if norm:
                    turn_fp.append({'sessionNo': s, 'turn': t, 'fp': norm})

            expected = qa.get('answer')
            if expected is None or str(expected).strip() == '':
                expected = qa.get('adversarial_answer')
            expected = '' if expected is None else str(expected)

            case_id = f'{sample_id}-q{qa_idx:03d}'
            cases.append({
                'id': case_id,
                'category': CATEGORY_NAMES[category],
                'categoryNo': category,
                'query': f'Question date: {last_date}\n{question}',
                'relevant': relevant,
                'expectedAnswer': expected,
                'shouldAbstain': CATEGORY_NAMES[category] == 'adversarial',
                'split': 'test',
                'corpusDir': corpus_dir,
                'question': question,
                'questionDate': last_date,
                'goldTurns': turn_fp,
                'droppedEvidenceRefs': dropped,
                'adversarialAnswer': qa.get('adversarial_answer'),
                'sampleId': sample_id,
            })
            dataset_rows.append({
                'question_id': case_id,
                'question_date': last_date,
                'question': question,
                'haystack_session_ids': [session_ids[n] for n in session_nos],
                'haystack_dates': [sess_dates[n] for n in session_nos],
            })
        per_conv[sample_id] = conv_stats

    # write artifacts
    with open(os.path.join(out, 'cases.jsonl'), 'w', encoding='utf-8') as fh:
        for row in cases:
            fh.write(json.dumps(row, ensure_ascii=False) + '\n')
    with open(os.path.join(out, 'locomo-dataset.json'), 'w', encoding='utf-8') as fh:
        json.dump(dataset_rows, fh, ensure_ascii=False)
    meta['perConversation'] = per_conv
    meta['corpusDirs'] = corpus_dirs
    meta['datasetSha256'] = dataset_sha
    with open(os.path.join(out, 'adapter-meta.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, indent=2, ensure_ascii=False)

    by_cat = collections.Counter(c['category'] for c in cases)
    print(json.dumps({
        'out': out,
        'cases': len(cases),
        'byCategory': dict(sorted(by_cat.items())),
        'sessions': meta['sessions'],
        'turnsRendered': meta['turns_rendered'],
        'imageTurnsSkipped': meta['image_turns_skipped'],
        'droppedEvidenceRefs': meta['evidence_refs_unparseable_dropped'],
        'questionsWithoutEvidence': meta['questions_without_evidence_sessions'],
    }, indent=1))


if __name__ == '__main__':
    main()