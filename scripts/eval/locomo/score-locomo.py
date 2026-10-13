#!/usr/bin/env python3
"""
Renor-on-LoCoMo scorer (scripts/eval/locomo/score-locomo.py).

Reads the adapter cases.jsonl, the retrieval results.jsonl, and optionally the
frozen harness qa-cases.jsonl, and produces score-report.json + score-report.md.

Metrics (all documented in the manifest / report):
- J metric (when --qa is provided): judge verdict accuracy (gemma4:31b binary
  judge), overall + per category. Judge gold = LoCoMo `answer` field (or
  `adversarial_answer` for category 5 when `answer` is null).
- Headline protocol: categories 1–4 (1,540 questions) as LLM-judge accuracy;
  category 5 (446) reported separately as an abstention metric. This is a Renor
  evaluation protocol, not the official LoCoMo token-overlap/F1 protocol.
- recall-any@5/@10/@20: session-level gold. recallAny@K = any gold session in top-K.
- MRR: reciprocal rank of the first gold session.
- recallAll@20: all gold sessions in top-20 (multi-session completeness).
- turn-level bonus: gold turn's normalized 48-char text fingerprint appears in
  any retrieved chunk text (top-20).
- context tokens + answer/judge/retrieval latency when QA is present.

Honest-scope notes are embedded in the report. Never compare a Renor LLM-judge
percentage with official-paper F1 unless labelled protocol-incomparable.
"""
import argparse
import collections
import json
import os


HEADLINE_CATEGORIES = ('single-hop', 'multi-hop', 'temporal', 'open-domain')
ADVERSARIAL_CATEGORY = 'adversarial'


def read_jsonl(path):
    with open(path, 'r', encoding='utf-8') as fh:
        return [json.loads(line) for line in fh if line.strip()]


def pct(n, d):
    return round(n / d, 4) if d else None


def percentile(values, p):
    if not values:
        return None
    s = sorted(values)
    return s[max(0, min(len(s) - 1, int(round(p * (len(s) - 1)))))]


def stats(values):
    if not values:
        return {'mean': None, 'p50': None, 'p95': None}
    return {
        'mean': round(sum(values) / len(values), 1),
        'p50': percentile(values, 0.5),
        'p95': percentile(values, 0.95),
    }


def _is_idk(ans_text: str) -> bool:
    compact = ans_text.lower().replace('.', '').replace("'", '')
    return compact in ('i dont know',) or ans_text.strip() == "I don't know."


def compute(cases, results, qa=None):
    per_cat = collections.defaultdict(lambda: collections.Counter())
    recall = {5: [0, 0], 10: [0, 0], 20: [0, 0]}
    recall_all20 = [0, 0]
    mrr_sum = 0.0
    mrr_n = 0
    turn_got = turn_tot = 0
    ctx_tokens, answer_latency, judge_latency, retr_latency = [], [], [], []

    rows = []
    source = qa if qa is not None else [{'id': cid} for cid in cases]
    for row in source:
        case = cases[row['id']]
        result = results[row['id']]
        cat = case['category']
        c = per_cat[cat]
        c['n'] += 1

        verdict = None
        is_idk = False
        if qa is not None:
            judge = row.get('judge') or {}
            verdict = judge.get('verdict') if judge.get('parseOk') else None
            ans_text = ((row.get('answer') or {}).get('text') or '').strip()
            is_idk = _is_idk(ans_text)
            if verdict is None:
                c['judgeError' if row.get('judge') else 'apiError'] += 1
            else:
                if verdict == 1:
                    c['correct'] += 1
                if is_idk:
                    c['idk'] += 1
                else:
                    c['answered'] += 1
                    if verdict == 1:
                        c['correctExcludingIdk'] += 1
            ctx_tokens.append(row.get('contextTokens') or 0)
            if row.get('answer'):
                answer_latency.append(row['answer'].get('latencyMs') or 0)
            if row.get('judge'):
                judge_latency.append(row['judge'].get('latencyMs') or 0)

        gold = {rel['notePath'] for rel in case.get('relevant') or []}
        ranks = []
        if gold:
            hits = result.get('hits') or []
            ranks = [i + 1 for i, h in enumerate(hits) if h.get('notePath') in gold]
            for k in (5, 10, 20):
                recall[k][0] += 1 if any(r <= k for r in ranks) else 0
                recall[k][1] += 1
            gold_in_top20 = {h.get('notePath') for h in hits[:20]}
            if gold <= gold_in_top20:
                recall_all20[0] += 1
            recall_all20[1] += 1
            mrr_sum += (1.0 / ranks[0]) if ranks else 0.0
            mrr_n += 1

        for t in case.get('goldTurns') or []:
            turn_tot += 1
            fp = t['fp']
            for h in result.get('hits') or []:
                text = (h.get('text') or '').lower().replace('\n', ' ')
                if fp in text:
                    turn_got += 1
                    break

        retr_latency.append(result.get('latencyMs') or 0)
        rows.append({
            'id': row['id'],
            'category': cat,
            'verdict': verdict,
            'idk': is_idk,
            'goldRanks': ranks[:5],
            'goldSessions': len(gold),
        })

    by_category = {
        cat: {
            'n': c['n'],
            'correct': c.get('correct', 0),
            'accuracy': pct(c.get('correct', 0), c['n']),
            'idkAnswers': c.get('idk', 0),
            'answered': c.get('answered', 0),
            'correctAmongAnswered': pct(c.get('correctExcludingIdk', 0), c.get('answered', 0)),
            'judgeError': c.get('judgeError', 0),
            'apiError': c.get('apiError', 0),
        } for cat, c in sorted(per_cat.items())
    }

    headline_ids = [r for r in rows if r['category'] in HEADLINE_CATEGORIES]
    adversarial_ids = [r for r in rows if r['category'] == ADVERSARIAL_CATEGORY]
    headline_correct = sum(1 for r in headline_ids if r['verdict'] == 1)
    adversarial_idk = sum(1 for r in adversarial_ids if r['idk'])
    adversarial_correct = sum(1 for r in adversarial_ids if r['verdict'] == 1)
    has_qa = qa is not None

    report = {
        'benchmark': 'locomo10-renor-qa-end-to-end',
        'metricProtocol': 'renor-llm-judge-cats14-v1-not-official-f1',
        'protocolNote': (
            'Headline = categories 1–4 LLM-judge accuracy. Category 5 is an '
            'abstention metric reported separately. Do not compare with official '
            'LoCoMo token-overlap/F1 or with competitor numbers from another evaluator.'
        ),
        'cases': len(source),
        'headlineCats14': {
            'n': len(headline_ids),
            'correct': headline_correct if has_qa else 0,
            'accuracy': pct(headline_correct, len(headline_ids)) if has_qa else None,
        },
        'adversarialAbstention': {
            'n': len(adversarial_ids),
            'idkAnswers': adversarial_idk if has_qa else 0,
            'idkRate': pct(adversarial_idk, len(adversarial_ids)) if has_qa else None,
            'judgeCorrect': adversarial_correct if has_qa else 0,
            'judgeAccuracy': pct(adversarial_correct, len(adversarial_ids)) if has_qa else None,
        },
        'accuracyAll': pct(sum(1 for r in rows if r['verdict'] == 1), len(rows)) if has_qa else None,
        'byCategory': by_category,
        'recallAny': {f'@{k}': pct(v[0], v[1]) for k, v in recall.items()},
        'recallAll@20': pct(recall_all20[0], recall_all20[1]),
        'mrr': round(mrr_sum / max(1, mrr_n), 4),
        'turnLevelBonus': pct(turn_got, turn_tot),
        'contextTokens': stats(ctx_tokens),
        'answerLatencyMs': stats(answer_latency),
        'judgeLatencyMs': stats(judge_latency),
        'retrievalLatencyMs': stats(retr_latency),
        'perCase': rows,
    }
    return report


def write_markdown(report, path):
    lines = [
        '# LoCoMo Renor score report',
        '',
        f"Protocol: `{report['metricProtocol']}`",
        '',
        report['protocolNote'],
        '',
        '## Headline (categories 1–4)',
        '',
    ]
    h = report['headlineCats14']
    acc = 'n/a' if h['accuracy'] is None else f"{100 * h['accuracy']:.1f}%"
    lines.append(f"- n={h['n']} correct={h['correct']} accuracy={acc}")
    lines.append('')
    lines.append('## Adversarial (category 5, abstention metric)')
    lines.append('')
    a = report['adversarialAbstention']
    idk = 'n/a' if a['idkRate'] is None else f"{100 * a['idkRate']:.1f}%"
    lines.append(f"- n={a['n']} IDK={a['idkAnswers']} ({idk}); judge-correct={a['judgeCorrect']}")
    lines.append('')
    lines.append('## Per-category')
    lines.append('')
    lines.append('| category | n | correct | accuracy | IDK | answered |')
    lines.append('|---|---|---|---|---|---|')
    for cat, c in report['byCategory'].items():
        cat_acc = 'n/a' if c['accuracy'] is None else f"{100 * c['accuracy']:.1f}%"
        lines.append(
            f"| {cat} | {c['n']} | {c['correct']} | {cat_acc} | {c['idkAnswers']} | {c['answered']} |"
        )
    lines.append('')
    lines.append('## Retrieval')
    lines.append('')
    ra = report['recallAny']
    lines.append(
        f"- recall-any@5={ra.get('@5')} @10={ra.get('@10')} @20={ra.get('@20')} "
        f"recallAll@20={report['recallAll@20']} MRR={report['mrr']}"
    )
    lines.append('')
    lines.append('Official LoCoMo F1 numbers are protocol-incomparable with this LLM-judge protocol.')
    lines.append('')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cases', required=True)
    ap.add_argument('--results', required=True)
    ap.add_argument('--qa', help='qa-cases.jsonl from the frozen harness (omit for retrieval-only)')
    ap.add_argument('--output', required=True, help='output directory for score-report.json')
    args = ap.parse_args()

    cases = {r['id']: r for r in read_jsonl(args.cases)}
    results = {r['id']: r for r in read_jsonl(args.results)}
    missing = [cid for cid in cases if cid not in results]
    extra = [rid for rid in results if rid not in cases]
    if extra:
        raise SystemExit(f'results contain ids absent from cases: {extra[:5]}')
    if args.qa:
        qa = read_jsonl(args.qa)
        missing_qa = [row['id'] for row in qa if row['id'] not in cases or row['id'] not in results]
        if missing_qa:
            raise SystemExit(f'qa ids missing from cases/results: {missing_qa[:5]}')
    else:
        qa = None
        if missing:
            raise SystemExit(f'retrieval-only scoring requires every case to have a result; missing {len(missing)}')

    report = compute(cases, results, qa)
    os.makedirs(args.output, exist_ok=True)
    with open(os.path.join(args.output, 'score-report.json'), 'w', encoding='utf-8') as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    write_markdown(report, os.path.join(args.output, 'score-report.md'))
    summary = {
        'cases': report['cases'],
        'headlineCats14': report['headlineCats14'],
        'adversarialAbstention': report['adversarialAbstention'],
        'recallAny': report['recallAny'],
        'mrr': report['mrr'],
    }
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
