#!/usr/bin/env python3
"""
Convert Renor QA output into BEAM official evaluator answer JSON.

Official run_evaluation.py expects a JSON object keyed by capability, each
value a list of {question, llm_response} in the same order as
probing_questions.json. This exporter rebuilds that shape from adapter cases
+ qa-cases.jsonl so the official GPT evaluator can be pointed at a Renor
sample without changing BEAM's code.

Official input layout (one file per conversation):
  results/<scale>/<chat_id>/<name>.json
Official CLI:
  python -m src.evaluation.run_evaluation \
    --input_directory results/100K --chat_size 100K \
    --start_index 0 --end_index 1 \
    --allowed_result_files <name>.json
"""
import argparse
import json
import os
import re
import sys


CAPABILITIES = [
    'abstention',
    'contradiction_resolution',
    'event_ordering',
    'information_extraction',
    'instruction_following',
    'knowledge_update',
    'multi_session_reasoning',
    'preference_following',
    'summarization',
    'temporal_reasoning',
]

CASE_ID_RE = re.compile(r'^beam-[^-]+-c(\d+)-(.+)-(\d+)$')


def read_jsonl(path):
    with open(path, 'r', encoding='utf-8') as fh:
        return [json.loads(line) for line in fh if line.strip()]


def answer_text(row):
    ans = row.get('answer')
    if isinstance(ans, str):
        return ans
    if isinstance(ans, dict):
        return ans.get('text') or ''
    return row.get('raw') or ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cases', required=True)
    ap.add_argument('--qa', required=True)
    ap.add_argument('--output', required=True, help='official-style results/<scale>/ tree')
    ap.add_argument('--scale', default='100K')
    ap.add_argument('--name', default='renor-answers.json')
    args = ap.parse_args()

    cases = {r['id']: r for r in read_jsonl(args.cases)}
    qa = {r['id']: r for r in read_jsonl(args.qa)}

    by_chat = {}
    for cid, case in cases.items():
        m = CASE_ID_RE.match(cid)
        if not m:
            sys.exit(f'unparseable case id: {cid}')
        chat_id = str(int(m.group(1)))
        cap = m.group(2)
        idx = int(m.group(3))
        if cid not in qa:
            continue
        by_chat.setdefault(chat_id, {c: [] for c in CAPABILITIES})
        q_text = case.get('question') or case.get('query', '')
        if q_text.startswith('Question date:'):
            q_text = q_text.split('\n', 1)[-1]
        by_chat[chat_id][cap].append({
            'index': idx,
            'question': q_text,
            'llm_response': answer_text(qa[cid]),
        })

    for chat_id, caps in by_chat.items():
        payload = {}
        for cap in CAPABILITIES:
            rows = sorted(caps[cap], key=lambda r: r['index'])
            payload[cap] = [{'question': r['question'], 'llm_response': r['llm_response']} for r in rows]
        dest_dir = os.path.join(args.output, args.scale, chat_id)
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, args.name)
        with open(dest, 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
            fh.write('\n')

    print(json.dumps({'chats': sorted(by_chat), 'scale': args.scale, 'file': args.name}))


if __name__ == '__main__':
    main()
