"""Page figures for the dev100 guard: recall at 20 hits, off vs on, with the ids that gain and lose (no model call).
usage: guard-compare.py <off-run-dir> <on-run-dir>
Each run dir is a dump-longmemeval-pages.ts output: cases.jsonl (id, relevant[].notePath) and results.jsonl (id, hits[].notePath)."""
import json, sys

def load(run):
    cases = {}
    for line in open(f"{run}/cases.jsonl"):
        c = json.loads(line)
        cases[c["id"]] = {r["notePath"] for r in c.get("relevant", []) if r.get("notePath") and r.get("relevance", 0) > 0}
    pages = {}
    for line in open(f"{run}/results.jsonl"):
        r = json.loads(line)
        pages[r["id"]] = {h.get("notePath") for h in r.get("hits", [])}
    return cases, pages

def found(run):
    cases, pages = load(run)
    out = {}
    for qid, gold in cases.items():
        if not gold:
            continue
        out[qid] = bool(gold & pages.get(qid, set()))
    return out

off, on = found(sys.argv[1]), found(sys.argv[2])
ids = sorted(set(off) & set(on))
recall_off = sum(off[i] for i in ids) / len(ids)
recall_on = sum(on[i] for i in ids) / len(ids)
print(json.dumps({
    "questions": len(ids),
    "recallOff": recall_off,
    "recallOn": recall_on,
    "gains": [i for i in ids if on[i] and not off[i]],
    "losses": [i for i in ids if off[i] and not on[i]],
}, indent=2))
