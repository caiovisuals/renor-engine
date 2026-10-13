#!/usr/bin/env python3
"""Unit tests for the LoCoMo scorer (headline cats 1–4 vs adversarial)."""
import os
import sys
import tempfile
import unittest

import importlib.util

_SCORE_PATH = os.path.join(os.path.dirname(__file__), 'score-locomo.py')
_SPEC = importlib.util.spec_from_file_location('score_locomo', _SCORE_PATH)
score_locomo = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(score_locomo)
compute = score_locomo.compute


def case(cid, category, note, gold_turns=None):
    return {
        'id': cid,
        'category': category,
        'relevant': [{'notePath': note}],
        'goldTurns': gold_turns or [],
    }


def result(cid, hits, latency=10):
    return {'id': cid, 'hits': hits, 'latencyMs': latency}


def qa(cid, verdict, text, parse_ok=True):
    return {
        'id': cid,
        'answer': {'text': text, 'latencyMs': 5},
        'judge': {'verdict': verdict, 'parseOk': parse_ok, 'latencyMs': 3},
        'contextTokens': 100,
    }


class ScoreLocomoTest(unittest.TestCase):
    def test_headline_excludes_adversarial(self):
        cases = {
            'a': case('a', 'single-hop', 'Sessions/s1.md'),
            'b': case('b', 'multi-hop', 'Sessions/s2.md'),
            'c': case('c', 'adversarial', 'Sessions/s3.md'),
        }
        results = {
            'a': result('a', [{'notePath': 'Sessions/s1.md', 'text': 'gold turn text here'}]),
            'b': result('b', [{'notePath': 'Sessions/other.md', 'text': 'nope'}]),
            'c': result('c', [{'notePath': 'Sessions/s3.md', 'text': 'x'}]),
        }
        qas = [
            qa('a', 1, 'May 7'),
            qa('b', 0, "I don't know."),
            qa('c', 0, "I don't know."),
        ]
        report = compute(cases, results, qas)
        self.assertEqual(report['headlineCats14']['n'], 2)
        self.assertEqual(report['headlineCats14']['correct'], 1)
        self.assertEqual(report['headlineCats14']['accuracy'], 0.5)
        self.assertEqual(report['adversarialAbstention']['n'], 1)
        self.assertEqual(report['adversarialAbstention']['idkAnswers'], 1)
        self.assertEqual(report['adversarialAbstention']['idkRate'], 1.0)
        self.assertEqual(report['recallAny']['@20'], 0.6667)
        self.assertEqual(report['metricProtocol'], 'renor-llm-judge-cats14-v1-not-official-f1')

    def test_retrieval_only_has_no_accuracy(self):
        cases = {'a': case('a', 'temporal', 'Sessions/s1.md')}
        results = {'a': result('a', [{'notePath': 'Sessions/s1.md', 'text': ''}])}
        report = compute(cases, results, None)
        self.assertIsNone(report['accuracyAll'])
        self.assertEqual(report['headlineCats14']['n'], 1)
        self.assertEqual(report['headlineCats14']['correct'], 0)
        self.assertIsNone(report['headlineCats14']['accuracy'])
        self.assertEqual(report['recallAny']['@5'], 1.0)

    def test_cli_retrieval_only(self):
        import json
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            cases_path = os.path.join(tmp, 'cases.jsonl')
            results_path = os.path.join(tmp, 'results.jsonl')
            out = os.path.join(tmp, 'out')
            with open(cases_path, 'w') as fh:
                fh.write(json.dumps(case('a', 'open-domain', 'Sessions/s1.md')) + '\n')
            with open(results_path, 'w') as fh:
                fh.write(json.dumps(result('a', [{'notePath': 'Sessions/s1.md', 'text': ''}])) + '\n')
            subprocess.check_call([
                sys.executable, os.path.join(os.path.dirname(__file__), 'score-locomo.py'),
                '--cases', cases_path, '--results', results_path, '--output', out,
            ])
            with open(os.path.join(out, 'score-report.json')) as fh:
                report = json.load(fh)
            self.assertEqual(report['headlineCats14']['n'], 1)
            self.assertTrue(os.path.isfile(os.path.join(out, 'score-report.md')))


if __name__ == '__main__':
    unittest.main()
