#!/usr/bin/env python3
"""
Renor-on-BEAM adapter (ICLR 2026 BEAM benchmark).

Converts each BEAM conversation (from github.com/mohammadtavakoli78/BEAM, CC BY-SA 4.0)
into Renor-style session files and emits the artifacts consumed by the QA harness
and nugget scorer:

  <out>/corpus/conv-<NN>/Sessions/conv-<NN>-session-<batch>.md   one unique file per session
  <out>/cases.jsonl                                     retrieval cases (frozen schema)
  <out>/beam-dataset.json                               LongMemEval-compatible dataset format
  <out>/adapter-meta.json                               counts + metadata

Capabilities covered (10 total):
  abstention, contradiction_resolution, event_ordering, information_extraction,
  instruction_following, knowledge_update, multi_session_reasoning,
  preference_following, summarization, temporal_reasoning
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
import sys

DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

def parse_beam_date(date_str: str) -> tuple[datetime, str]:
    """Parse Month-DD-YYYY into datetime and LongMemEval-style string 'YYYY/MM/DD (DOW) 12:00'."""
    clean = date_str.strip()
    dt = datetime.strptime(clean, "%B-%d-%Y")
    dow_str = DOW[dt.weekday()]
    formatted = f"{dt.year:04d}/{dt.month:02d}/{dt.day:02d} ({dow_str}) 12:00"
    return dt, formatted

def extract_expected_answer(q_obj: dict) -> str:
    """Extract reference answer across varying field names in BEAM capabilities."""
    for field in ('ideal_response', 'ideal_answer', 'answer', 'expected_compliance', 'ideal_summary'):
        if field in q_obj and q_obj[field]:
            val = q_obj[field]
            return val if isinstance(val, str) else json.dumps(val)
    return ''

def main():
    parser = argparse.ArgumentParser(description="Convert BEAM chats into Renor-style session corpus and cases")
    parser.add_argument("--beam-chats-dir", required=True, help="Path to BEAM scale directory (e.g. chats/100K)")
    parser.add_argument("--output", required=True, help="Output directory for adapter artifacts")
    parser.add_argument("--scale", default="100K", help="Scale identifier (100K, 500K, 1M, 10M)")
    args = parser.parse_args()

    chats_dir = os.path.abspath(args.beam_chats_dir)
    out_dir = os.path.abspath(args.output)
    os.makedirs(out_dir, exist_ok=True)

    chat_subdirs = [d for d in os.listdir(chats_dir) if os.path.isdir(os.path.join(chats_dir, d))]
    # Sort numerically
    chat_subdirs.sort(key=lambda x: int(x) if x.isdigit() else x)

    cases = []
    dataset_rows = []
    total_sessions = 0
    total_turns_rendered = 0
    cap_counts = {}

    for chat_name in chat_subdirs:
        chat_id_int = int(chat_name) if chat_name.isdigit() else 0
        conv_dir_name = f"conv-{chat_id_int:02d}"
        conv_corpus_dir = os.path.join(out_dir, "corpus", conv_dir_name)
        sessions_dir = os.path.join(conv_corpus_dir, "Sessions")
        os.makedirs(sessions_dir, exist_ok=True)

        chat_json_path = os.path.join(chats_dir, chat_name, "chat.json")
        pq_json_path = os.path.join(chats_dir, chat_name, "probing_questions", "probing_questions.json")

        if not os.path.isfile(chat_json_path):
            print(f"Skipping {chat_name}: no chat.json", file=sys.stderr)
            continue

        with open(chat_json_path, "r", encoding="utf-8") as f:
            chat_batches = json.load(f)

        haystack_session_ids = []
        haystack_dates = []
        last_dt = None
        last_date_str = "2024/01/01 (Mon) 12:00"

        for b_idx, batch in enumerate(chat_batches):
            batch_no = batch.get("batch_number", b_idx + 1)
            sess_id = f"{conv_dir_name}-s{batch_no}"

            # Search for date anchor in turns
            date_raw = None
            turn_groups = batch.get("turns", [])
            for group in turn_groups:
                if isinstance(group, list):
                    for msg in group:
                        if msg.get("time_anchor"):
                            date_raw = msg.get("time_anchor")
                            break
                elif isinstance(group, dict) and group.get("time_anchor"):
                    date_raw = group.get("time_anchor")
                if date_raw:
                    break

            if date_raw:
                try:
                    dt, date_formatted = parse_beam_date(date_raw)
                    last_dt = dt
                    last_date_str = date_formatted
                except Exception:
                    dt = datetime(2024, 1, 1, 12, 0)
                    date_formatted = last_date_str
            else:
                dt = last_dt if last_dt else datetime(2024, 1, 1, 12, 0)
                date_formatted = last_date_str

            haystack_session_ids.append(sess_id)
            haystack_dates.append(date_formatted)

            # Flatten messages in batch
            messages = []
            for group in turn_groups:
                if isinstance(group, list):
                    for msg in group:
                        messages.append(msg)
                elif isinstance(group, dict):
                    messages.append(group)

            body_lines = []
            for m_idx, msg in enumerate(messages, 1):
                role = msg.get("role", "User")
                role_label = "Assistant" if role.lower() == "assistant" else "User"
                content = msg.get("content", "").strip()
                body_lines.append(f"### Turn {m_idx} — {role_label}\n\n{content}")
                total_turns_rendered += 1

            sess_md = (
                f"---\n"
                f"kind: beam-session\n"
                f"session_id: \"{sess_id}\"\n"
                f"session_date: \"{date_formatted}\"\n"
                f"---\n"
                f"# Session {sess_id}\n\n"
                f"Timestamp: {date_formatted}\n\n"
                + "\n\n".join(body_lines)
                + "\n"
            )

            # Unique across conversations so session-assembly cannot mix chats
            # that all named their files session-01.md.
            sess_filename = f"{conv_dir_name}-session-{batch_no:02d}.md"
            sess_file_path = os.path.join(sessions_dir, sess_filename)
            with open(sess_file_path, "w", encoding="utf-8") as f:
                f.write(sess_md)

            ts_epoch = dt.timestamp()
            os.utime(sess_file_path, (ts_epoch, ts_epoch))
            total_sessions += 1

        # Now process probing questions
        if os.path.isfile(pq_json_path):
            with open(pq_json_path, "r", encoding="utf-8") as f:
                pq_data = json.load(f)

            for cap_name, q_list in pq_data.items():
                cap_counts[cap_name] = cap_counts.get(cap_name, 0) + len(q_list)
                for q_idx, q_item in enumerate(q_list):
                    q_text = q_item.get("question", "").strip()
                    expected = extract_expected_answer(q_item)
                    rubric = q_item.get("rubric", [])
                    case_id = f"beam-{args.scale.lower()}-c{chat_id_int:02d}-{cap_name}-{q_idx}"

                    case_row = {
                        "id": case_id,
                        "query": f"Question date: {last_date_str}\n{q_text}",
                        "corpusDir": conv_corpus_dir,
                        "expectedAnswer": expected,
                        "category": cap_name,
                        "shouldAbstain": (cap_name == "abstention"),
                        "rubric": rubric,
                        "difficulty": q_item.get("difficulty", "medium"),
                        "question": q_text,
                        "questionDate": last_date_str,
                        "relevant": [
                            {
                                "notePath": f"Sessions/{conv_dir_name}-session-{i+1:02d}.md",
                                "match": haystack_session_ids[i],
                                "role": "session",
                            }
                            for i in range(len(haystack_session_ids))
                        ],
                    }
                    cases.append(case_row)

                    ds_row = {
                        "question_id": case_id,
                        "question_date": last_date_str,
                        "question": q_text,
                        "haystack_session_ids": haystack_session_ids,
                        "haystack_dates": haystack_dates,
                        "answer": expected,
                        "rubric": rubric,
                        "category": cap_name,
                    }
                    dataset_rows.append(ds_row)

    # Write cases.jsonl
    cases_path = os.path.join(out_dir, "cases.jsonl")
    with open(cases_path, "w", encoding="utf-8") as f:
        for c in cases:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    # Write beam-dataset.json
    dataset_path = os.path.join(out_dir, "beam-dataset.json")
    with open(dataset_path, "w", encoding="utf-8") as f:
        json.dump(dataset_rows, f, indent=2, ensure_ascii=False)

    hasher = hashlib.sha256()
    for dirpath, _, filenames in os.walk(chats_dir):
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, chats_dir)
            hasher.update(rel.encode('utf-8'))
            hasher.update(b'\0')
            with open(full, 'rb') as fh:
                hasher.update(fh.read())

    meta = {
        "scale": args.scale,
        "license": "CC BY-SA 4.0",
        "source": "github.com/mohammadtavakoli78/BEAM",
        "chats": len(chat_subdirs),
        "totalSessions": total_sessions,
        "totalTurnsRendered": total_turns_rendered,
        "totalCases": len(cases),
        "byCapability": cap_counts,
        "adapterOutput": out_dir,
        "datasetSha256": hasher.hexdigest(),
    }
    meta_path = os.path.join(out_dir, "adapter-meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print(json.dumps(meta, indent=2))

if __name__ == "__main__":
    main()
