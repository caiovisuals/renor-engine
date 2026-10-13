"""Acceptance tests for the offline ChatGPT-export importer.

All fixtures are SYNTHETIC — constructed in-memory/temp dirs. No real export,
real memory content, real secrets, network, LLM, or embedding calls.

Run from the repository root:
    python3 -m unittest discover -s tests/chatgpt_import -v
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import time
import unittest
import zipfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from scripts.chatgpt_import import promote as promote_mod  # noqa: E402
from scripts.chatgpt_import.importer import run, run_cli  # noqa: E402
from scripts.chatgpt_import.promote import run as promote_run  # noqa: E402
from scripts.chatgpt_import.source import Limits, SourceError  # noqa: E402


# ---------------------------------------------------------------------------
# Synthetic fixture helpers


def msg(role, parts, content_type="text", create_time=1700000000.0, message_id=None,
        channel=None, metadata=None, hidden=None):
    message = {
        "id": message_id or f"m-{role}-{int(create_time)}",
        "author": {"role": role},
        "create_time": create_time,
        "content": {"content_type": content_type, "parts": parts},
    }
    if channel is not None:
        message["channel"] = channel
    if metadata is not None:
        message["metadata"] = metadata
    if hidden is not None:
        message["hidden"] = hidden
    return message


def linear_conv(conv_id, title, messages, **extra):
    """Build a conversation whose mapping is a single chain; current_node = last."""
    mapping = {}
    prev = None
    for i, message in enumerate(messages):
        node_id = f"n{i}"
        mapping[node_id] = {"parent": prev, "children": [], "message": message}
        if prev is not None:
            mapping[prev]["children"].append(node_id)
        prev = node_id
    conv = {
        "conversation_id": conv_id,
        "title": title,
        "create_time": 1700000000.0,
        "update_time": 1700000100.0,
        "mapping": mapping,
        "current_node": prev,
    }
    conv.update(extra)
    return conv


def branched_conv(conv_id, title, main_messages, alt_messages):
    """main chain then a side branch from the root node."""
    mapping = {}
    prev = None
    for i, message in enumerate(main_messages):
        node_id = f"m{i}"
        mapping[node_id] = {"parent": prev, "children": [], "message": message}
        if prev is not None:
            mapping[prev]["children"].append(node_id)
        prev = node_id
    alt_prev = "m0"  # branch off the first main node
    for i, message in enumerate(alt_messages):
        node_id = f"a{i}"
        mapping[node_id] = {"parent": alt_prev, "children": [], "message": message}
        mapping[alt_prev]["children"].append(node_id)
        alt_prev = node_id
    return {
        "conversation_id": conv_id,
        "title": title,
        "create_time": 1700000000.0,
        "update_time": 1700000100.0,
        "mapping": mapping,
        "current_node": prev,
    }


def write_zip(path, shards, extra_members=None):
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in shards.items():
            zf.writestr(name, json.dumps(data))
        for name, data in (extra_members or {}).items():
            zf.writestr(name, data)


def read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def sha_file(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def note_path(staging, name):
    return os.path.join(staging, "notes", name)


def parse_frontmatter(text):
    assert text.startswith("---\n")
    end = text.index("\n---\n", 3)
    block = text[4:end]
    fields = {}
    for line in block.split("\n"):
        if not line.strip():
            continue
        key, value = line.split(": ", 1)
        if value in ("true", "false"):
            fields[key] = value == "true"
        else:
            try:
                fields[key] = int(value)
            except ValueError:
                fields[key] = json.loads(value)
    return fields, text[end + 5:]


def snapshot_tree(root):
    snap = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames + filenames:
            full = os.path.join(dirpath, name)
            snap[os.path.relpath(full, root)] = (os.path.islink(full), os.path.getmtime(full))
    return snap


class ImporterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="chatgpt-import-test-")
        self.source_dir = os.path.join(self.tmp, "source")
        self.staging = os.path.join(self.tmp, "staging")
        os.makedirs(self.source_dir)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_import(self, source, apply=True, limits=None):
        return run(source, self.staging, apply=apply, limits=limits)

    # -- basic two-shard import --------------------------------------------

    def test_two_shard_zip_import(self):
        zip_path = os.path.join(self.source_dir, "export.zip")
        conv_a = linear_conv("conv-aaa", "Alpha chat", [
            msg("user", ["hello there"]),
            msg("assistant", ["hi! how can I help?"]),
        ])
        conv_b = linear_conv("conv-bbb", "Beta chat", [
            msg("user", ["second conversation"]),
            msg("assistant", ["answer two"]),
            msg("user", ["follow up"]),
            msg("assistant", ["final answer"]),
        ])
        conv_c = linear_conv("conv-ccc", "Gamma chat", [
            msg("user", ["third one"]),
            msg("assistant", ["third answer"]),
        ])
        write_zip(zip_path,
                  {"conversations-000.json": [conv_a, conv_b],
                   "conversations-001.json": [conv_c]},
                  extra_members={"user-attachments/photo.bin": b"\x00binary-not-read",
                                 "README.txt": "ignored"})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["records_seen"], 3)
        self.assertEqual(summary["imported"]["created"], 3)
        self.assertEqual(summary["unsupported"], 0)
        self.assertEqual(summary["skipped"]["privacy"], 0)
        # notes, MOC, manifest all present
        names = sorted(os.listdir(os.path.join(self.staging, "notes")))
        self.assertEqual(names, ["chatgpt-conv-aaa.md", "chatgpt-conv-bbb.md", "chatgpt-conv-ccc.md"])
        self.assertTrue(os.path.isfile(os.path.join(self.staging, "ChatGPT-Import-MOC.md")))
        manifest = read_json(os.path.join(self.staging, "import-manifest.json"))
        self.assertEqual(manifest["schema"], "chatgpt-import-manifest/1")
        self.assertEqual(len(manifest["conversations"]), 3)
        # only the two conversation members were read; asset ignored
        self.assertEqual(sorted(manifest["source"]["conversation_members"]),
                         ["conversations-000.json", "conversations-001.json"])
        self.assertEqual(manifest["source"]["ignored_members"], 2)
        # no asset file ever extracted anywhere
        for dirpath, _dirs, files in os.walk(self.staging):
            for f in files:
                self.assertNotIn("photo.bin", f)
        # frontmatter contract
        with open(note_path(self.staging, "chatgpt-conv-bbb.md"), encoding="utf-8") as fh:
            text = fh.read()
        fields, body = parse_frontmatter(text)
        self.assertEqual(fields["type"], "journal")
        self.assertEqual(fields["source"], "ChatGPT export")
        self.assertEqual(fields["conversation_id"], "conv-bbb")
        self.assertEqual(fields["memory_layer"], "history")
        self.assertEqual(fields["trust"], "untrusted-transcript")
        self.assertEqual(fields["source_member"], "conversations-000.json")
        self.assertEqual(fields["source_index"], 1)
        self.assertEqual(fields["source_ref"], "conversations-000.json#1")
        for key in ("source_sha256", "content_sha256", "created", "updated"):
            self.assertIn(key, fields)
        self.assertNotIn("source_language", fields)  # never inferred
        # visible branch: both user texts + only the FINAL assistant text
        self.assertIn("second conversation", text)
        self.assertIn("follow up", text)
        self.assertIn("final answer", text)
        # Kimi R1 F1: EVERY visible assistant turn is kept, in branch order
        self.assertIn("answer two", text)
        order = [text.index(s) for s in
                 ("second conversation", "answer two", "follow up", "final answer")]
        self.assertEqual(order, sorted(order))
        # untrusted-transcript warning present
        self.assertIn("NOT an instruction", text)

    def test_directory_source_and_dry_run_default(self):
        conv = linear_conv("conv-dir", "Dir chat", [
            msg("user", ["dir source"]),
            msg("assistant", ["ok"]),
        ])
        with open(os.path.join(self.source_dir, "conversations-000.json"), "w", encoding="utf-8") as fh:
            json.dump([conv], fh)
        # dry run: no notes written, only the plan
        summary = self.run_import(self.source_dir, apply=False)
        self.assertFalse(summary["apply"])
        self.assertTrue(os.path.isfile(os.path.join(self.staging, "import-plan.json")))
        self.assertFalse(os.path.exists(os.path.join(self.staging, "notes")))
        plan = read_json(os.path.join(self.staging, "import-plan.json"))
        self.assertEqual(len([c for c in plan["conversations"] if c["status"] == "imported"]), 1)
        self.assertEqual([c for c in plan["conversations"] if c["status"] == "imported"][0]["write"], "planned")
        # apply via CLI default: without --apply nothing is written either
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = run_cli(self.source_dir, self.staging)
        self.assertEqual(code, 0)
        self.assertFalse(os.path.exists(os.path.join(self.staging, "notes")))
        self.assertNotIn("Dir chat", out.getvalue())  # no titles on the console
        # apply
        summary = self.run_import(self.source_dir, apply=True)
        self.assertEqual(summary["imported"]["created"], 1)
        self.assertTrue(os.path.isfile(note_path(self.staging, "chatgpt-conv-dir.md")))

    # -- edited / regenerated active branch ---------------------------------

    def test_edited_active_branch_updates_note(self):
        zip_path = os.path.join(self.source_dir, "export.zip")
        conv = linear_conv("conv-edit", "Edit chat", [
            msg("user", ["question one"]),
            msg("assistant", ["answer one"]),
        ])
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        # regenerate: the active branch moved on (new user turn + new final answer)
        conv2 = linear_conv("conv-edit", "Edit chat", [
            msg("user", ["question one"]),
            msg("assistant", ["answer one"]),
            msg("user", ["question two"], create_time=1700000500.0),
            msg("assistant", ["answer two"], create_time=1700000600.0),
        ])
        write_zip(zip_path, {"conversations-000.json": [conv2]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["imported"]["updated"], 1)
        with open(note_path(self.staging, "chatgpt-conv-edit.md"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("question two", text)
        self.assertIn("answer two", text)
        self.assertIn("answer one", text)  # Kimi R1 F1: every visible assistant turn kept
        order = [text.index(s) for s in
                 ("question one", "answer one", "question two", "answer two")]
        self.assertEqual(order, sorted(order))
        fields, _ = parse_frontmatter(text)
        self.assertNotIn("assistant_omitted", fields)  # field retired with the F1 fix

    # -- malformed graphs ----------------------------------------------------

    def test_malformed_graph_missing_parent(self):
        conv = {
            "conversation_id": "conv-orphan", "title": "t", "create_time": 1.0,
            "update_time": 2.0,
            "mapping": {
                "n0": {"parent": None, "children": ["n1"], "message": msg("user", ["hi"])},
                "n1": {"parent": "missing-node", "children": [], "message": msg("assistant", ["x"])},
            },
            "current_node": "n1",
        }
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["skipped"]["invalid_graph"], 1)
        self.assertEqual(summary["imported"]["created"], 0)
        manifest = read_json(os.path.join(self.staging, "import-manifest.json"))
        bad = [c for c in manifest["conversations"] if c["status"] == "skipped-invalid"]
        self.assertEqual(len(bad), 1)
        self.assertIn("orphan-parent-reference", bad[0]["detail"])  # explicit per-record report
        # no note was written for the invalid record
        self.assertFalse(os.path.exists(os.path.join(self.staging, "notes")))

    def test_cycle_rejected(self):
        conv = {
            "conversation_id": "conv-cycle", "title": "t", "create_time": 1.0, "update_time": 2.0,
            "mapping": {
                "n0": {"parent": "n1", "children": ["n1"], "message": msg("user", ["a"]),
                       },
                "n1": {"parent": "n0", "children": ["n0"], "message": msg("assistant", ["b"])},
            },
            "current_node": "n0",
        }
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["skipped"]["invalid_graph"], 1)
        manifest = read_json(os.path.join(self.staging, "import-manifest.json"))
        bad = [c for c in manifest["conversations"] if c["status"] == "skipped-invalid"][0]
        self.assertIn("cycle", bad["detail"])

    def test_unreachable_branch_node_is_omitted_not_fatal(self):
        conv = {
            "conversation_id": "conv-mismatch", "title": "t", "create_time": 1.0, "update_time": 2.0,
            "mapping": {
                "n0": {"parent": None, "children": ["n1"], "message": msg("user", ["a"])},
                "n1": {"parent": "n0", "children": [],
                       "message": msg("assistant", ["b"])},
                "n2": {"parent": "n1", "children": [], "message": msg("assistant", ["c"])},
            },
            "current_node": "n1",
        }
        # n0 lists child n1, but n1's parent is n0 — consistent; make n2 unreachable:
        # n0.children must contain n1 AND n2 must not be a child of anything
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        summary = self.run_import(zip_path, apply=True)
        # n2 is a valid-but-unreachable branch node: record imports, branch omitted
        self.assertEqual(summary["imported"]["created"], 1)

    def test_current_node_unresolvable(self):
        conv = {
            "conversation_id": "conv-cu", "title": "t", "create_time": 1.0, "update_time": 2.0,
            "mapping": {"n0": {"parent": None, "children": [], "message": msg("user", ["hi"])}},
            "current_node": "nope",
        }
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["skipped"]["invalid_graph"], 1)

    def test_duplicate_conversation_id(self):
        conv = linear_conv("conv-dup", "Dup", [msg("user", ["x"])])
        conv2 = linear_conv("conv-dup", "Dup2", [msg("user", ["y"])])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv], "conversations-001.json": [conv2]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["skipped"]["duplicate_id"], 1)
        self.assertEqual(summary["imported"]["created"], 1)

    # -- privacy --------------------------------------------------------------

    def test_do_not_remember_skipped(self):
        zip_path = os.path.join(self.source_dir, "export.zip")
        conv_ok = linear_conv("conv-ok", "Fine", [msg("user", ["keep me"])])
        conv_dnr = linear_conv("conv-dnr", "Secret chat", [msg("user", ["forget me"])],
                               is_do_not_remember=True)
        conv_dnr_false = linear_conv("conv-dnr2", "Fine 2", [msg("user", ["keep me too"])],
                                     is_do_not_remember=False)
        write_zip(zip_path, {"conversations-000.json": [conv_ok, conv_dnr, conv_dnr_false]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["skipped"]["privacy"], 1)
        self.assertEqual(summary["imported"]["created"], 2)
        notes = os.listdir(os.path.join(self.staging, "notes"))
        self.assertEqual(sorted(notes), ["chatgpt-conv-dnr2.md", "chatgpt-conv-ok.md"])
        # content of the skipped conversation never appears anywhere in staging
        for dirpath, _dirs, files in os.walk(self.staging):
            for f in files:
                with open(os.path.join(dirpath, f), "rb") as fh:
                    self.assertNotIn(b"forget me", fh.read())

    def test_reasoning_channels_excluded(self):
        conv = branched_conv("conv-reason", "Reason", [
            msg("user", ["please think"]),
            msg("assistant", ["internal thought content"], content_type="thoughts"),
            msg("assistant", ["recap of reasoning"], content_type="reasoning_recap"),
            msg("assistant", ["visible answer"]),
        ], [
            msg("assistant", ["alt branch text"]),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        with open(note_path(self.staging, "chatgpt-conv-reason.md"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertNotIn("internal thought content", text)
        self.assertNotIn("recap of reasoning", text)
        self.assertNotIn("alt branch text", text)  # alternative branch omitted
        self.assertIn("visible answer", text)
        fields, _body = parse_frontmatter(text)
        self.assertEqual(fields["reasoning_excluded"], 2)
        self.assertEqual(fields["omitted_branch_messages"], 1)

    def test_memory_scope_preserved_not_promoted(self):
        conv = linear_conv("conv-scope", "Scoped", [msg("user", ["project note"])],
                           memory_scope="project", is_archived=True)
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        with open(note_path(self.staging, "chatgpt-conv-scope.md"), encoding="utf-8") as fh:
            fields, _ = parse_frontmatter(fh.read())
        self.assertEqual(fields["memory_scope"], "project")
        self.assertTrue(fields["archived"])
        self.assertEqual(fields["memory_layer"], "history")  # never promoted to facts
        self.assertEqual(fields["type"], "journal")

    # -- attachments / multimodal -----------------------------------------------

    def test_multimodal_placeholders(self):
        conv = linear_conv("conv-mm", "MM", [
            msg("user", [
                "look at this",
                {"content_type": "image_asset_pointer", "asset_pointer": "file-service://x"},
                12345,
            ], content_type="multimodal_text"),
            msg("assistant", ["got it"], content_type="text"),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        with open(note_path(self.staging, "chatgpt-conv-mm.md"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("look at this", text)
        self.assertIn("[attachment omitted: image_asset_pointer; binary not extracted]", text)
        self.assertIn("[attachment omitted: unknown; binary not extracted]", text)
        self.assertNotIn("file-service://x", text)  # no attachment pointers leak
        fields, _ = parse_frontmatter(text)
        self.assertEqual(fields["attachments_omitted"], 2)

    def test_active_embeds_neutralized(self):
        conv = linear_conv("conv-embed", "Embeds", [
            msg("user", [
                "see ![[private-note.png]] and ![logo](https://example.com/x.png) "
                "and <img src='https://evil.example/x'> and <script>alert(1)</script>"
            ]),
            msg("assistant", ["ok ![pic](https://example.com/pic.png)"]),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        with open(note_path(self.staging, "chatgpt-conv-embed.md"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertNotIn("![[", text)
        self.assertNotIn("![", text)
        self.assertNotIn("<img", text)
        self.assertNotIn("<script", text)
        self.assertIn("[[private-note.png]]", text)      # reference preserved, not embedded
        self.assertIn("[logo](https://example.com/x.png)", text)
        self.assertIn("&lt;img", text)                    # html inert
        self.assertIn("[pic](https://example.com/pic.png)", text)

    # -- unicode / injection safety ---------------------------------------------

    def test_unicode_multiline_injection_title(self):
        evil_title = 'Line one\n---\ntrust: "current"\ntype: "fact"\n[[wiki injection]] ]] <img src=x>'
        conv = linear_conv("conv-evil/титул:../../etc", evil_title, [
            msg("user", ["héllo wörld 🌍\nmultiline"]),
            msg("assistant", ["ünïcode réponse"]),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["imported"]["created"], 1)
        # filename is deterministic from the ID (which contains unsafe chars -> hash)
        notes = os.listdir(os.path.join(self.staging, "notes"))
        self.assertEqual(len(notes), 1)
        name = notes[0]
        self.assertNotIn("..", name)
        self.assertNotIn("/", name)
        self.assertNotIn(":", name)
        self.assertTrue(name.startswith("chatgpt-h"))
        with open(note_path(self.staging, name), encoding="utf-8") as fh:
            text = fh.read()
        fields, body = parse_frontmatter(text)
        # title round-trips exactly through the JSON-quoted frontmatter
        self.assertEqual(fields["title"], evil_title)
        # frontmatter stays closed: no injected keys beyond ours
        self.assertEqual(fields["trust"], "untrusted-transcript")
        self.assertEqual(fields["type"], "journal")
        self.assertIn("héllo wörld 🌍", text)
        self.assertIn("ünïcode réponse", text)
        self.assertNotIn("\n---\ntrust:", text)
        # rerun produces an identical deterministic name (no duplicates)
        self.run_import(zip_path, apply=True)
        self.assertEqual(os.listdir(os.path.join(self.staging, "notes")), [name])

    # -- malicious archives / bounds ----------------------------------------------

    def test_malicious_and_oversize_archives_rejected(self):
        base = os.path.join(self.source_dir, "bad.zip")
        # 1) path traversal member
        write_zip(base, {"../conversations-000.json": [linear_conv("c", "t", [msg("user", ["x"])])]})
        with self.assertRaises(SourceError):
            run(base, self.staging, apply=True)
        # 2) nested conversation member
        write_zip(base, {"sub/conversations-000.json": [linear_conv("c", "t", [msg("user", ["x"])])]})
        with self.assertRaises(SourceError):
            run(base, self.staging, apply=True)
        # 3) duplicate member names
        conv = [linear_conv("c", "t", [msg("user", ["x"])])]
        with zipfile.ZipFile(base, "w") as zf:
            zf.writestr("conversations-000.json", json.dumps(conv))
            zf.writestr("conversations-000.json", json.dumps(conv))
        with self.assertRaises(SourceError):
            run(base, self.staging, apply=True)
        # 4) oversized member (tiny limit)
        write_zip(base, {"conversations-000.json": conv})
        limits = Limits(max_member_bytes=8)
        with self.assertRaises(SourceError):
            run(base, self.staging, apply=True, limits=limits)
        with self.assertRaises(SourceError):
            run(base, self.staging, apply=True, limits=Limits(max_total_bytes=8))
        # nothing was ever written into staging by any rejected run
        self.assertFalse(os.path.exists(os.path.join(self.staging, "notes")))
        # 5) absolute member name
        with zipfile.ZipFile(base, "w") as zf:
            info = zipfile.ZipInfo("/etc/conversations-000.json")
            zf.writestr(info, json.dumps(conv))
        with self.assertRaises(SourceError):
            run(base, self.staging, apply=True)
        # 6) not-found source
        with self.assertRaises(SourceError):
            run(os.path.join(self.source_dir, "missing.zip"), self.staging, apply=True)

    # -- secrets ------------------------------------------------------------------

    def test_high_confidence_redaction(self):
        synth_key = "sk-SYNTHETICtestkey1234567890abcd"
        synth_aws = "AKIAIOSFODNN7EXAMPLE"
        conv = linear_conv("conv-secrets", "Secrets", [
            msg("user", [f"use {synth_key} and {synth_aws} please"]),
            msg("assistant", [f"done, key {synth_key} was used"]),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        with open(note_path(self.staging, "chatgpt-conv-secrets.md"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertNotIn(synth_key, text)
        self.assertNotIn(synth_aws, text)
        self.assertEqual(text.count("[REDACTED:openai-style-key#"), 2)
        self.assertEqual(text.count("[REDACTED:aws-access-key#"), 1)
        fields, _ = parse_frontmatter(text)
        self.assertEqual(fields["redacted"], 3)
        self.assertFalse(fields["quarantined"])
        manifest = read_json(os.path.join(self.staging, "import-manifest.json"))
        entry = [c for c in manifest["conversations"] if c["conversation_id"] == "conv-secrets"][0]
        self.assertEqual(entry["redacted"], 3)
        self.assertEqual(entry["status"], "imported")
        # console output never contains the raw values
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            run_cli(zip_path, self.staging)
        self.assertNotIn(synth_key, out.getvalue())
        self.assertNotIn(synth_aws, out.getvalue())

    def test_private_key_block_redacted(self):
        pem = ("-----BEGIN SYNTHETIC PRIVATE KEY-----\nMIISYNTHETICNOTAKEY000\n"
               "-----END SYNTHETIC PRIVATE KEY-----")
        conv = linear_conv("conv-pem", "PEM", [msg("user", [f"key:\n{pem}"])])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        with open(note_path(self.staging, "chatgpt-conv-pem.md"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertNotIn("MIISYNTHETICNOTAKEY000", text)
        self.assertIn("[REDACTED:private-key#", text)

    def test_uncertain_candidates_quarantined(self):
        conv = linear_conv("conv-quar", "Quarantine", [
            msg("user", ["my password = hunter2syntheticvalue and go on"]),
            msg("assistant", ["noted (locally only)"]),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["quarantined"], 1)
        self.assertEqual(summary["imported"]["created"], 0)
        quar_path = os.path.join(self.staging, "quarantine", "chatgpt-conv-quar.md")
        self.assertTrue(os.path.isfile(quar_path))
        self.assertFalse(os.path.exists(note_path(self.staging, "chatgpt-conv-quar.md")))
        with open(quar_path, encoding="utf-8") as fh:
            fields, _ = parse_frontmatter(fh.read())
        self.assertTrue(fields["quarantined"])
        self.assertEqual(fields["quarantine_reasons"], "credential-assignment")
        # the uncertain text stays in private staging (not redacted, not published)
        with open(quar_path, encoding="utf-8") as fh:
            self.assertIn("hunter2syntheticvalue", fh.read())
        # MOC lists it under quarantine and not under imported
        with open(os.path.join(self.staging, "ChatGPT-Import-MOC.md"), encoding="utf-8") as fh:
            moc = fh.read()
        self.assertIn("Quarantined", moc)
        self.assertIn("quarantine/chatgpt-conv-quar.md", moc)
        imported_section = moc.split("## Imported notes", 1)[1].split("##", 1)[0]
        self.assertNotIn("conv-quar", imported_section)
        # manifest blocks automatic promotion
        manifest = read_json(os.path.join(self.staging, "import-manifest.json"))
        entry = [c for c in manifest["conversations"] if c["conversation_id"] == "conv-quar"][0]
        self.assertEqual(entry["status"], "quarantined")

    # -- idempotency / conflicts ----------------------------------------------------

    def test_idempotent_rerun(self):
        convs = [linear_conv(f"conv-{i}", f"Chat {i}", [
            msg("user", [f"q{i}"]), msg("assistant", [f"a{i}"]),
        ]) for i in range(3)]
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": convs})
        self.run_import(zip_path, apply=True)
        note = note_path(self.staging, "chatgpt-conv-0.md")
        stat_before = os.stat(note)
        time.sleep(0.02)
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["imported"]["unchanged"], 3)
        self.assertEqual(summary["imported"]["created"], 0)
        self.assertEqual(summary["imported"]["updated"], 0)
        stat_after = os.stat(note)
        self.assertEqual(stat_before.st_mtime_ns, stat_after.st_mtime_ns)  # no overwrite
        self.assertEqual(summary["moc_write"], "unchanged")
        self.assertEqual(len(os.listdir(os.path.join(self.staging, "notes"))), 3)  # no duplicates

    def test_human_edit_conflict(self):
        conv = linear_conv("conf-1", "Conflict", [
            msg("user", ["original question"]),
            msg("assistant", ["original answer"]),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        note = note_path(self.staging, "chatgpt-conf-1.md")
        with open(note, "rb") as fh:
            human_bytes = fh.read() + b"\n<!-- human edit -->\n"
        with open(note, "wb") as fh:
            fh.write(human_bytes)
        # unchanged source, human-edited file: conflict, file preserved, candidate copied
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["imported"]["conflicted"], 1)
        with open(note, "rb") as fh:
            self.assertEqual(fh.read(), human_bytes)  # human edit never overwritten
        cand = os.path.join(self.staging, "conflicts", "notes", "chatgpt-conf-1.md")
        self.assertTrue(os.path.isfile(cand))
        with open(cand, "rb") as fh:
            self.assertNotIn(b"human edit", fh.read())
        manifest = read_json(os.path.join(self.staging, "import-manifest.json"))
        entry = [c for c in manifest["conversations"] if c["conversation_id"] == "conf-1"][0]
        self.assertEqual(entry["write"], "conflicted")

    def test_changed_source_with_unchanged_output_updates(self):
        conv = linear_conv("upd-1", "Update", [msg("user", ["v1 question"])])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        conv2 = linear_conv("upd-1", "Update", [msg("user", ["v2 question"])])
        write_zip(zip_path, {"conversations-000.json": [conv2]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["imported"]["updated"], 1)
        with open(note_path(self.staging, "chatgpt-upd-1.md"), encoding="utf-8") as fh:
            self.assertIn("v2 question", fh.read())
        self.assertEqual(len(os.listdir(os.path.join(self.staging, "notes"))), 1)

    def test_unmanifested_existing_file_is_conflict(self):
        conv = linear_conv("umf-1", "Unmanifested", [msg("user", ["q"])])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        # seed a pre-existing file with no manifest record
        os.makedirs(self.staging, mode=0o700)
        os.makedirs(os.path.join(self.staging, "notes"))
        with open(note_path(self.staging, "chatgpt-umf-1.md"), "wb") as fh:
            fh.write(b"# someone else's file\n")
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["imported"]["conflicted"], 1)
        with open(note_path(self.staging, "chatgpt-umf-1.md"), "rb") as fh:
            self.assertEqual(fh.read(), b"# someone else's file\n")

    # -- source integrity / confinement --------------------------------------------

    def test_source_archive_untouched_and_no_outside_writes(self):
        conv = linear_conv("src-1", "Source integrity", [
            msg("user", ["question"]),
            msg("assistant", ["answer"]),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        before_sha = sha_file(zip_path)
        before_source_dir = snapshot_tree(self.source_dir)
        self.run_import(zip_path, apply=True)
        self.run_import(zip_path, apply=True)
        self.assertEqual(sha_file(zip_path), before_sha)          # archive never rewritten
        self.assertEqual(snapshot_tree(self.source_dir), before_source_dir)
        # everything written lives under staging
        for dirpath, dirnames, filenames in os.walk(self.tmp):
            rel = os.path.relpath(dirpath, self.tmp)
            if rel.startswith("staging") or rel.startswith("source"):
                continue
            self.assertEqual(filenames, [], f"unexpected file outside staging: {rel}")

    def test_staging_symlink_refused(self):
        conv = linear_conv("sym-1", "Sym", [msg("user", ["q"])])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        os.makedirs(self.staging, mode=0o700)
        link = os.path.join(self.staging, "notes")
        os.symlink(os.path.join(self.tmp, "elsewhere"), link)
        summary = run(zip_path, self.staging, apply=True)   # hostile symlink refused per-record
        self.assertEqual(summary["skipped"]["output_error"], 1)
        # the symlink target was never created through the importer
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "elsewhere")))

    # -- Kimi R1 regression coverage (F1-F9) -------------------------------

    def test_f1_all_visible_turns_in_active_branch_order(self):
        conv = linear_conv("conv-multi", "Repeated exchange", [
            msg("user", ["first question"], create_time=1700000000.0),
            msg("assistant", ["FIRST-ANSWER-VISIBLE"], create_time=1700000010.0),
            msg("user", ["second question"], create_time=1700000020.0),
            msg("assistant", ["SECOND-ANSWER-VISIBLE"], create_time=1700000030.0),
            msg("user", ["third question"], create_time=1700000040.0),
            msg("assistant", ["THIRD-ANSWER-VISIBLE"], create_time=1700000050.0),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        with open(note_path(self.staging, "chatgpt-conv-multi.md"), encoding="utf-8") as fh:
            text = fh.read()
        for token in ("first question", "FIRST-ANSWER-VISIBLE", "second question",
                      "SECOND-ANSWER-VISIBLE", "third question", "THIRD-ANSWER-VISIBLE"):
            self.assertIn(token, text)
        order = [text.index(t) for t in
                 ("first question", "FIRST-ANSWER-VISIBLE", "second question",
                  "SECOND-ANSWER-VISIBLE", "third question", "THIRD-ANSWER-VISIBLE")]
        self.assertEqual(order, sorted(order))

    def test_f2_analysis_channel_excluded(self):
        conv_a = linear_conv("conv-chA", "Trailing analysis", [
            msg("user", ["user turn"]),
            msg("assistant", ["INTERNAL-ANALYSIS-TEXT chain of thought"], channel="analysis"),
        ])
        conv_b = linear_conv("conv-chB", "Mid analysis", [
            msg("user", ["q"]),
            msg("assistant", ["MID-ANALYSIS-TEXT"], channel="analysis"),
            msg("assistant", ["FINAL-VISIBLE"], channel="final"),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv_a, conv_b]})
        self.run_import(zip_path, apply=True)
        with open(note_path(self.staging, "chatgpt-conv-chA.md"), encoding="utf-8") as fh:
            text_a = fh.read()
        self.assertNotIn("INTERNAL-ANALYSIS-TEXT", text_a)
        self.assertIn("user turn", text_a)
        fields_a, _ = parse_frontmatter(text_a)
        self.assertEqual(fields_a["internal_channels_excluded"], 1)
        with open(note_path(self.staging, "chatgpt-conv-chB.md"), encoding="utf-8") as fh:
            text_b = fh.read()
        self.assertNotIn("MID-ANALYSIS-TEXT", text_b)
        self.assertIn("FINAL-VISIBLE", text_b)
        fields_b, _ = parse_frontmatter(text_b)
        self.assertEqual(fields_b["internal_channels_excluded"], 1)

    def test_f2_channel_conflict_hidden_and_metadata_fail_closed(self):
        conv = linear_conv("conv-ch3", "Conflict/hidden/metadata", [
            msg("user", ["q1"]),
            msg("assistant", ["CONFLICT-EXCLUDED"], channel="final",
                metadata={"channel": "analysis"}),
            msg("assistant", ["META-EXCLUDED"], metadata={"channel": "analysis"}),
            msg("assistant", ["HIDDEN-FLAG-EXCLUDED"], hidden=True),
            msg("assistant", ["VISIBILITY-EXCLUDED"], metadata={"visibility": "hidden"}),
            msg("assistant", ["VISIBLE-OK"], channel="final"),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        with open(note_path(self.staging, "chatgpt-conv-ch3.md"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertNotIn("CONFLICT-EXCLUDED", text)      # conflicting tags fail closed
        self.assertNotIn("META-EXCLUDED", text)          # metadata.channel honored
        self.assertNotIn("HIDDEN-FLAG-EXCLUDED", text)   # hidden flag
        self.assertNotIn("VISIBILITY-EXCLUDED", text)    # metadata.visibility hidden
        self.assertIn("VISIBLE-OK", text)
        fields, _ = parse_frontmatter(text)
        self.assertEqual(fields["internal_channels_excluded"], 2)
        self.assertEqual(fields["hidden_excluded"], 2)

    def test_f3_dnr_transition_retires_stale_note(self):
        conv_v1 = linear_conv("conv-dnr", "Was fine", [
            msg("user", ["LATER-PRIVATE-CONTENT please remember this for now"]),
            msg("assistant", ["ok"]),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv_v1]})
        self.run_import(zip_path, apply=True)
        conv_v2 = linear_conv("conv-dnr", "Was fine", [
            msg("user", ["LATER-PRIVATE-CONTENT please remember this for now"]),
            msg("assistant", ["ok"]),
        ], is_do_not_remember=True)
        write_zip(zip_path, {"conversations-000.json": [conv_v2]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["skipped"]["privacy"], 1)
        self.assertEqual(summary["retired"], 1)
        note_rel = note_path(self.staging, "chatgpt-conv-dnr.md")
        self.assertFalse(os.path.exists(note_rel))  # out of the promotable area
        retired = os.path.join(self.staging, "retired", "notes", "chatgpt-conv-dnr.md")
        self.assertTrue(os.path.isfile(retired))      # moved, not deleted
        with open(retired, encoding="utf-8") as fh:
            self.assertIn("LATER-PRIVATE-CONTENT", fh.read())  # bytes preserved
        manifest = read_json(os.path.join(self.staging, "import-manifest.json"))
        transitions = [t for t in manifest["transitions"] if t["rel"] == "notes/chatgpt-conv-dnr.md"]
        self.assertEqual(len(transitions), 1)
        self.assertEqual(transitions[0]["action"], "retired")
        self.assertEqual(transitions[0]["current_status"], "skipped-privacy")
        self.assertTrue(transitions[0]["performed"])
        # the excluded content is no longer anywhere under notes/
        for dirpath, _dirs, files in os.walk(os.path.join(self.staging, "notes")):
            for f in files:
                with open(os.path.join(dirpath, f), encoding="utf-8") as fh:
                    self.assertNotIn("LATER-PRIVATE-CONTENT", fh.read())
        # MOC reflects the retirement
        with open(os.path.join(self.staging, "ChatGPT-Import-MOC.md"), encoding="utf-8") as fh:
            moc = fh.read()
        self.assertIn("Retired this run", moc)
        self.assertIn("retired/notes/chatgpt-conv-dnr.md", moc)
        imported_section = moc.split("## Imported notes", 1)[1].split("##", 1)[0]
        self.assertNotIn("conv-dnr", imported_section)

    def test_f3_human_edited_stale_note_blocks_retirement(self):
        conv_v1 = linear_conv("conv-hum", "Was fine", [
            msg("user", ["STALE-CONTENT"]),
            msg("assistant", ["ok"]),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv_v1]})
        self.run_import(zip_path, apply=True)
        note_rel = note_path(self.staging, "chatgpt-conv-hum.md")
        human_bytes = open(note_rel, "rb").read() + b"\n<!-- human edit -->\n"
        with open(note_rel, "wb") as fh:
            fh.write(human_bytes)
        conv_v2 = linear_conv("conv-hum", "Was fine", [
            msg("user", ["STALE-CONTENT"]),
            msg("assistant", ["ok"]),
        ], is_do_not_remember=True)
        write_zip(zip_path, {"conversations-000.json": [conv_v2]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["retire_blocked"], 1)
        self.assertEqual(summary["retired"], 0)
        # NEVER moved/deleted/overwritten
        self.assertEqual(open(note_rel, "rb").read(), human_bytes)
        manifest = read_json(os.path.join(self.staging, "import-manifest.json"))
        transition = [t for t in manifest["transitions"]
                      if t["rel"] == "notes/chatgpt-conv-hum.md"][0]
        self.assertEqual(transition["action"], "retire-blocked")
        # manifest authority: the conversation is not imported, so promotion
        # can never pick the physical leftover up
        statuses = [c for c in manifest["conversations"] if c.get("conversation_id") == "conv-hum"]
        self.assertEqual(statuses[0]["status"], "skipped-privacy")

    def test_f4_quarantine_and_disappear_transitions_retire(self):
        zip_path = os.path.join(self.source_dir, "export.zip")
        clean = linear_conv("conv-keep", "Keep", [msg("user", ["keep"])])
        quar_v1 = linear_conv("conv-q4", "Q", [msg("user", ["hello"])])
        gone = linear_conv("conv-gone", "G", [msg("user", ["bye"])])
        write_zip(zip_path, {"conversations-000.json": [clean, quar_v1, gone]})
        self.run_import(zip_path, apply=True)
        quar_v2 = linear_conv("conv-q4", "Q", [
            msg("user", ["hello"]),
            msg("assistant", ["my password = hunter2syntheticvalue ok?"]),
        ])
        # gone disappears entirely from the source
        write_zip(zip_path, {"conversations-000.json": [clean, quar_v2]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["quarantined"], 1)
        self.assertEqual(summary["retired"], 2)
        self.assertFalse(os.path.exists(note_path(self.staging, "chatgpt-conv-q4.md")))
        self.assertFalse(os.path.exists(note_path(self.staging, "chatgpt-conv-gone.md")))
        self.assertTrue(os.path.isfile(os.path.join(self.staging, "retired", "notes",
                                                   "chatgpt-conv-q4.md")))
        self.assertTrue(os.path.isfile(os.path.join(self.staging, "retired", "notes",
                                                   "chatgpt-conv-gone.md")))
        self.assertTrue(os.path.isfile(os.path.join(self.staging, "quarantine",
                                                   "chatgpt-conv-q4.md")))
        manifest = read_json(os.path.join(self.staging, "import-manifest.json"))
        actions = {t["rel"]: t["action"] for t in manifest["transitions"]}
        self.assertEqual(actions["notes/chatgpt-conv-q4.md"], "retired")
        self.assertEqual(actions["notes/chatgpt-conv-gone.md"], "retired")

    def test_f5_off_branch_corruption_imports_valid_branch(self):
        conv = {
            "conversation_id": "conv-altbad", "title": "Valid branch, corrupt alt",
            "create_time": 1700000000.0, "update_time": 1700000100.0,
            "mapping": {
                "n0": {"parent": None, "children": ["n1"],
                       "message": msg("user", ["VALID-USER-TURN"])},
                "n1": {"parent": "n0", "children": [],
                       "message": msg("assistant", ["VALID-ASSISTANT-ANSWER"])},
                "a0": {"parent": "ghost-node-not-in-mapping", "children": [],
                       "message": msg("assistant", ["corrupt alt branch"])},
            },
            "current_node": "n1",
        }
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["skipped"]["invalid_graph"], 0)
        self.assertEqual(summary["imported"]["created"], 1)
        with open(note_path(self.staging, "chatgpt-conv-altbad.md"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("VALID-USER-TURN", text)
        self.assertIn("VALID-ASSISTANT-ANSWER", text)
        self.assertNotIn("corrupt alt branch", text)
        fields, _ = parse_frontmatter(text)
        self.assertEqual(fields["off_branch_defects"], 1)
        manifest = read_json(os.path.join(self.staging, "import-manifest.json"))
        entry = [c for c in manifest["conversations"]
                 if c.get("conversation_id") == "conv-altbad"][0]
        self.assertEqual(entry["off_branch_defects"], 1)
        self.assertIn("off-branch-orphan-parent-reference", entry["off_branch_defect_samples"][0])

    def test_f5_off_branch_cycle_counted_not_fatal(self):
        conv = {
            "conversation_id": "conv-offcycle", "title": "Off-branch cycle",
            "create_time": 1700000000.0, "update_time": 1700000100.0,
            "mapping": {
                "n0": {"parent": None, "children": ["n1"],
                       "message": msg("user", ["q"])},
                "n1": {"parent": "n0", "children": [],
                       "message": msg("assistant", ["visible answer"])},
                "x0": {"parent": "x1", "children": ["x1"], "message": None},
                "x1": {"parent": "x0", "children": ["x0"], "message": None},
            },
            "current_node": "n1",
        }
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        summary = self.run_import(zip_path, apply=True)
        self.assertEqual(summary["imported"]["created"], 1)
        self.assertEqual(summary["skipped"]["invalid_graph"], 0)
        with open(note_path(self.staging, "chatgpt-conv-offcycle.md"), encoding="utf-8") as fh:
            fields, _ = parse_frontmatter(fh.read())
        self.assertGreaterEqual(fields["off_branch_defects"], 1)

    def test_f6_title_embeds_neutralized_in_heading(self):
        title = "ref ![[private-note.png]] and ![l](https://example.com/x.png) <img src=x>"
        conv = linear_conv("conv-titleembed", title, [
            msg("user", ["neutral body"]),
            msg("assistant", ["ok"]),
        ])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        with open(note_path(self.staging, "chatgpt-conv-titleembed.md"), encoding="utf-8") as fh:
            text = fh.read()
        h1 = next(line for line in text.splitlines() if line.startswith("# "))
        self.assertNotIn("![[", h1)
        self.assertNotIn("![", h1)
        self.assertNotIn("<img", h1)
        self.assertIn("[[private-note.png]]", h1)
        self.assertIn("[l](https://example.com/x.png)", h1)
        self.assertIn("&lt;img", h1)

    def test_f7_moc_table_injection_sanitized(self):
        bad_id = "injected | **[FAKE ROW](https://evil.example)** |\n| extra-row"
        conv = {
            "conversation_id": bad_id, "title": "t",
            "create_time": 1.0, "update_time": 2.0,
            "mapping": {"n0": {"parent": None, "children": [],
                               "message": msg("user", ["hi"])}},
            "current_node": "missing",
        }
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        with open(os.path.join(self.staging, "ChatGPT-Import-MOC.md"), encoding="utf-8") as fh:
            moc = fh.read()
        self.assertNotIn("FAKE ROW", moc)      # hostile id never rendered raw
        self.assertNotIn("extra-row", moc)
        self.assertNotIn("| |", moc.split("## Skipped conversations")[1]
                         if "## Skipped conversations" in moc else "")
        self.assertIn("unsafe-label-", moc)     # replaced by a deterministic hash label

    def test_f9_staging_is_owner_private(self):
        conv = linear_conv("conv-f9", "F9", [msg("user", ["q"])])
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": [conv]})
        self.run_import(zip_path, apply=True)
        mode = os.stat(self.staging).st_mode & 0o777
        self.assertEqual(mode, 0o700)
        # an insecure pre-existing staging root is rejected, never silently chmod-ed
        insecure = os.path.join(self.tmp, "staging-insecure")
        os.makedirs(insecure, mode=0o755)
        with self.assertRaises(Exception):
            run(zip_path, insecure, apply=True)
        self.assertEqual(os.stat(insecure).st_mode & 0o777, 0o755)  # untouched
        # a symlinked staging root is rejected
        link = os.path.join(self.tmp, "staging-link")
        os.symlink(os.path.join(self.tmp, "elsewhere"), link)
        with self.assertRaises(Exception):
            run(zip_path, link, apply=True)



def linear_conv_builder(conv_id, mapping, current_node):
    return {
        "conversation_id": conv_id, "title": "t", "create_time": 1.0, "update_time": 2.0,
        "mapping": mapping, "current_node": current_node,
    }




# ---------------------------------------------------------------------------
# Promotion command tests (manifest+hash authority, additive target)


class PromoteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="chatgpt-promote-test-")
        self.source_dir = os.path.join(self.tmp, "source")
        self.staging = os.path.join(self.tmp, "staging")
        self.target = os.path.join(self.tmp, "target", "ChatGPT History")
        os.makedirs(self.source_dir)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def import_zip(self, convs):
        zip_path = os.path.join(self.source_dir, "export.zip")
        write_zip(zip_path, {"conversations-000.json": convs})
        return run(zip_path, self.staging, apply=True)

    def promote(self, apply=False, digest=None):
        return promote_run(self.staging, self.target, apply=apply, manifest_digest=digest)

    def seed_vetted_staging(self):
        """Run 1: clean + future-DNR visible. Run 2: DNR marked + quarantine
        arrives — the repro_07-shaped staging the promotion must filter."""
        clean = linear_conv("conv-clean", "Clean", [
            msg("user", ["promote me"]), msg("assistant", ["sure"])])
        dnr_v1 = linear_conv("conv-gone-private", "DNR", [
            msg("user", ["DNR-EXCLUDED-CONTENT"]), msg("assistant", ["ok"])])
        self.import_zip([clean, dnr_v1])
        dnr_v2 = linear_conv("conv-gone-private", "DNR", [
            msg("user", ["DNR-EXCLUDED-CONTENT"]), msg("assistant", ["ok"])],
            is_do_not_remember=True)
        quar = linear_conv("conv-unsure", "Unsure", [
            msg("user", ["my password = hunter2syntheticvalue now"]),
            msg("assistant", ["noted"])])
        self.import_zip([clean, dnr_v2, quar])

    def test_promote_copies_only_manifest_listed_notes(self):
        self.seed_vetted_staging()
        plan = self.promote(apply=False)
        self.assertEqual(plan["selected"], 1)   # only conv-clean
        digest = plan["staging_manifest_digest"]
        summary = self.promote(apply=True, digest=digest)
        self.assertEqual(summary["promoted"]["created"], 1)
        self.assertEqual(sorted(os.listdir(self.target)),
                         ["ChatGPT-Import-MOC.md", "chatgpt-conv-clean.md",
                          "promote-manifest.json"])
        with open(os.path.join(self.target, "chatgpt-conv-clean.md"), encoding="utf-8") as fh:
            self.assertIn("promote me", fh.read())
        for path in os.listdir(self.target):
            with open(os.path.join(self.target, path), "rb") as fh:
                data = fh.read()
                self.assertNotIn(b"DNR-EXCLUDED-CONTENT", data)   # never copied
                self.assertNotIn(b"hunter2syntheticvalue", data)  # quarantine stays out
        with open(os.path.join(self.target, "ChatGPT-Import-MOC.md"), encoding="utf-8") as fh:
            moc = fh.read()
        self.assertIn("chatgpt-conv-clean", moc)
        self.assertNotIn("conv-gone-private", moc)
        self.assertNotIn("conv-unsure", moc)

    def test_promote_dry_run_writes_nothing(self):
        self.seed_vetted_staging()
        self.promote(apply=False)
        # Kimi R2-B: a dry-run request must not even materialize the target dir
        self.assertFalse(os.path.exists(self.target))

    def test_promote_rejects_tampered_staged_note(self):
        self.import_zip([linear_conv("conv-t", "T", [msg("user", ["q"])])])
        note = note_path(self.staging, "chatgpt-conv-t.md")
        with open(note, "ab") as fh:
            fh.write(b"tampered after review")
        with self.assertRaises(promote_mod.PromotionError):
            self.promote(apply=True, digest="0" * 64)
        # Kimi R2-B: a rejected request must not even materialize the target dir
        self.assertFalse(os.path.exists(self.target))   # zero target writes

    def test_promote_rejects_symlinked_staged_note(self):
        self.import_zip([linear_conv("conv-s", "S", [msg("user", ["q"])])])
        note = note_path(self.staging, "chatgpt-conv-s.md")
        outside = os.path.join(self.tmp, "outside.md")
        with open(outside, "wb") as fh:
            fh.write(b"decoy")
        os.unlink(note)
        os.symlink(outside, note)
        with self.assertRaises(promote_mod.PromotionError):
            self.promote(apply=True, digest="0" * 64)
        self.assertFalse(os.path.exists(self.target))
        self.assertEqual(open(outside, "rb").read(), b"decoy")

    def test_promote_idempotent_rerun_no_duplicates(self):
        self.import_zip([linear_conv("conv-i", "I", [msg("user", ["q"])])])
        digest = self.promote(apply=False)["staging_manifest_digest"]
        self.promote(apply=True, digest=digest)
        note = os.path.join(self.target, "chatgpt-conv-i.md")
        stat_before = os.stat(note)
        time.sleep(0.02)
        summary = self.promote(apply=True, digest=digest)
        self.assertEqual(summary["promoted"]["unchanged"], 1)
        self.assertEqual(summary["promoted"]["created"], 0)
        self.assertEqual(os.stat(note).st_mtime_ns, stat_before.st_mtime_ns)
        self.assertEqual([n for n in os.listdir(self.target) if n.startswith("chatgpt-")],
                         ["chatgpt-conv-i.md"])

    def test_promote_human_edit_collision_preserved(self):
        self.import_zip([linear_conv("conv-h", "H", [msg("user", ["q"])])])
        digest = self.promote(apply=False)["staging_manifest_digest"]
        self.promote(apply=True, digest=digest)
        note = os.path.join(self.target, "chatgpt-conv-h.md")
        human_bytes = open(note, "rb").read() + b"\n<!-- vault human edit -->\n"
        with open(note, "wb") as fh:
            fh.write(human_bytes)
        summary = self.promote(apply=True, digest=digest)
        self.assertEqual(summary["blocked"]["conflict"], 1)
        self.assertEqual(open(note, "rb").read(), human_bytes)  # never overwritten

    def test_promote_unowned_collision_preserved(self):
        self.import_zip([linear_conv("conv-u1", "U1", [msg("user", ["q1"])]),
                         linear_conv("conv-u2", "U2", [msg("user", ["q2"])])])
        os.makedirs(self.target, exist_ok=True)
        with open(os.path.join(self.target, "chatgpt-conv-u1.md"), "wb") as fh:
            fh.write(b"# someone else's vault note\n")
        digest = self.promote(apply=False)["staging_manifest_digest"]
        summary = self.promote(apply=True, digest=digest)
        self.assertEqual(summary["blocked"]["collision"], 1)
        self.assertEqual(summary["promoted"]["created"], 1)   # others proceed
        with open(os.path.join(self.target, "chatgpt-conv-u1.md"), "rb") as fh:
            self.assertEqual(fh.read(), b"# someone else's vault note\n")

    def test_promote_privacy_withdrawal_blocked_target_untouched(self):
        self.import_zip([linear_conv("conv-w", "W", [msg("user", ["withdrawn later"])])])
        digest = self.promote(apply=False)["staging_manifest_digest"]
        self.promote(apply=True, digest=digest)
        target_note = os.path.join(self.target, "chatgpt-conv-w.md")
        before = open(target_note, "rb").read()
        # the source now marks the conversation do-not-remember
        self.import_zip([linear_conv("conv-w", "W", [msg("user", ["withdrawn later"])],
                                     is_do_not_remember=True)])
        digest2 = self.promote(apply=False)["staging_manifest_digest"]
        summary = self.promote(apply=True, digest=digest2)
        self.assertEqual(summary["withdrawals_blocked"], 1)
        self.assertEqual(open(target_note, "rb").read(), before)  # never deleted/moved
        self.assertIn("withdrawal-blocked", json.dumps(summary))
        with open(os.path.join(self.target, "ChatGPT-Import-MOC.md"), encoding="utf-8") as fh:
            moc = fh.read()
        self.assertIn("Withdrawals blocked", moc)

    def test_promote_digest_mismatch_zero_writes(self):
        self.import_zip([linear_conv("conv-d", "D", [msg("user", ["q"])])])
        stale_digest = self.promote(apply=False)["staging_manifest_digest"]
        # the staging manifest changes after the review (new import run)
        self.import_zip([linear_conv("conv-d", "D", [msg("user", ["q"]),
                                                    msg("assistant", ["a"])])])
        with self.assertRaises(promote_mod.PromotionError):
            self.promote(apply=True, digest=stale_digest)
        self.assertFalse(os.path.exists(self.target))   # Kimi R2-B: nothing materialized

    def test_promote_requires_manifest_digest_for_apply(self):
        self.import_zip([linear_conv("conv-n", "N", [msg("user", ["q"])])])
        with self.assertRaises(promote_mod.PromotionError):
            self.promote(apply=True)     # no digest -> fail closed
        self.assertFalse(os.path.exists(self.target))

    def test_promote_missing_staging_manifest(self):
        os.makedirs(self.staging, mode=0o700)
        with self.assertRaises(promote_mod.PromotionError):
            self.promote(apply=False)
        self.assertFalse(os.path.exists(self.target))



    # -- Kimi R2 regression coverage (promotion surface only) --------------

    def promote_to(self, target, apply=False, digest=None, manifest_digest=None):
        return promote_run(self.staging, target, apply=apply,
                           manifest_digest=digest or manifest_digest)

    def test_r2b_rejected_or_dry_promotion_never_materializes_target(self):
        self.import_zip([linear_conv("conv-r2b", "B", [msg("user", ["q"])])])
        dry_target = os.path.join(self.tmp, "t-dry")
        self.promote_to(dry_target, apply=False)
        self.assertFalse(os.path.exists(dry_target))
        bad_target = os.path.join(self.tmp, "t-bad")
        with self.assertRaises(promote_mod.PromotionError):
            self.promote_to(bad_target, apply=True, digest="0" * 64)
        self.assertFalse(os.path.exists(bad_target))
        with self.assertRaises(promote_mod.PromotionError):
            self.promote_to(bad_target, apply=True)   # apply without digest
        self.assertFalse(os.path.exists(bad_target))
        # a legitimate apply does create it (and only then)
        digest = self.promote(apply=False)["staging_manifest_digest"]
        self.promote(apply=True, digest=digest)
        self.assertTrue(os.path.isdir(self.target))

    def test_r2a_withdrawal_warning_persists_and_moc_stays_truthful(self):
        self.import_zip([linear_conv("conv-w2", "W",
                                     [msg("user", ["WITHDRAWN-LATER-CONTENT"])])])
        d1 = self.promote(apply=False)["staging_manifest_digest"]
        self.promote(apply=True, digest=d1)
        target_note = os.path.join(self.target, "chatgpt-conv-w2.md")
        before = open(target_note, "rb").read()
        # privacy transition retires the staged note
        self.import_zip([linear_conv("conv-w2", "W",
                                     [msg("user", ["WITHDRAWN-LATER-CONTENT"])],
                                     is_do_not_remember=True)])
        d2 = self.promote(apply=False)["staging_manifest_digest"]
        first = self.promote(apply=True, digest=d2)
        self.assertEqual(first["withdrawals_blocked"], 1)
        self.assertEqual(open(target_note, "rb").read(), before)
        # repeat promotion on the SAME manifest: warning persists (no amnesia)
        second = self.promote(apply=True, digest=d2)
        self.assertEqual(second["withdrawals_blocked"], 1)
        self.assertGreaterEqual(second["ownership_carried"], 1)
        self.assertEqual(second["promoted"]["created"], 0)
        manifest = read_json(os.path.join(self.target, "promote-manifest.json"))
        entry = manifest["notes"].get("chatgpt-conv-w2.md")
        self.assertIsNotNone(entry)                       # remembered
        self.assertTrue(entry.get("carried"))              # never an update authority
        # target MOC regenerated even with an empty selection: the withdrawn
        # note must NOT be claimed under 'Promoted notes'
        with open(os.path.join(self.target, "ChatGPT-Import-MOC.md"), encoding="utf-8") as fh:
            moc = fh.read()
        promoted_section = moc.split("## Promoted notes", 1)[1].split("##", 1)[0]
        self.assertNotIn("chatgpt-conv-w2", promoted_section)
        self.assertIn("chatgpt-conv-w2", moc.split("## Withdrawals blocked")[1])

    def test_r2a_blocked_conflict_ownership_preserved_across_runs(self):
        self.import_zip([linear_conv("conv-b2", "B", [msg("user", ["q"])])])
        digest = self.promote(apply=False)["staging_manifest_digest"]
        self.promote(apply=True, digest=digest)
        note = os.path.join(self.target, "chatgpt-conv-b2.md")
        human_bytes = open(note, "rb").read() + b"\n<!-- human vault edit -->\n"
        with open(note, "wb") as fh:
            fh.write(human_bytes)
        first = self.promote(apply=True, digest=digest)
        self.assertEqual(first["blocked"]["conflict"], 1)
        manifest = read_json(os.path.join(self.target, "promote-manifest.json"))
        self.assertIn("chatgpt-conv-b2.md", manifest["notes"])   # ownership kept
        # repeat run: still blocked, file preserved, ownership still remembered
        second = self.promote(apply=True, digest=digest)
        self.assertEqual(second["blocked"]["conflict"], 1)
        self.assertEqual(open(note, "rb").read(), human_bytes)
        manifest = read_json(os.path.join(self.target, "promote-manifest.json"))
        self.assertIn("chatgpt-conv-b2.md", manifest["notes"])

    def test_r2a_carried_withdrawn_file_blocks_new_same_name_candidate(self):
        self.import_zip([linear_conv("conv-c2", "C", [msg("user", ["v1 content"])])])
        digest = self.promote(apply=False)["staging_manifest_digest"]
        self.promote(apply=True, digest=digest)
        target_note = os.path.join(self.target, "chatgpt-conv-c2.md")
        withdrawn_bytes = open(target_note, "rb").read()
        self.import_zip([linear_conv("conv-c2", "C", [msg("user", ["v1 content"])],
                                     is_do_not_remember=True)])
        d2 = self.promote(apply=False)["staging_manifest_digest"]
        self.promote(apply=True, digest=d2)               # withdrawal carried
        # the SAME id later reappears as a new visible conversation
        self.import_zip([linear_conv("conv-c2", "C", [msg("user", ["v2 content new"])])])
        d3 = self.promote(apply=False)["staging_manifest_digest"]
        summary = self.promote(apply=True, digest=d3)
        # the withdrawn file must never be overwritten by the new candidate
        self.assertEqual(open(target_note, "rb").read(), withdrawn_bytes)
        self.assertEqual(summary["blocked"]["collision"], 1)
        self.assertEqual(summary["promoted"]["created"], 0)

    def test_r2c_malformed_manifest_types_rejected_cleanly(self):
        self.import_zip([linear_conv("conv-m", "M", [msg("user", ["q"])])])
        manifest_path = os.path.join(self.staging, "import-manifest.json")
        good = read_json(manifest_path)
        for label, mutate in (
            ("notes-as-string", lambda m: m.__setitem__("notes", "tampered")),
            ("conversations-as-int", lambda m: m.__setitem__("conversations", 5)),
            ("notes-as-list", lambda m: m.__setitem__("notes", [])),
            ("conversations-as-string", lambda m: m.__setitem__("conversations", "x")),
        ):
            bad = json.loads(json.dumps(good))
            mutate(bad)
            with open(manifest_path, "w", encoding="utf-8") as fh:
                json.dump(bad, fh)
            outcome = "not-rejected"
            try:
                self.promote(apply=False)
            except promote_mod.PromotionError:
                outcome = "clean-rejection"
            except Exception as exc:  # noqa: BLE001 — any other type is the defect
                self.fail(f"{label}: uncaught {type(exc).__name__}: {exc}")
            self.assertEqual(outcome, "clean-rejection", f"{label}: {outcome}")
        # restore; clean run still works and target was never materialized
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(good, fh)
        self.promote(apply=False)
        self.assertFalse(os.path.exists(self.target))

    def test_r2d_duplicate_id_rows_refused(self):
        self.import_zip([linear_conv("conv-ab", "AB", [msg("user", ["q"]),
                                                       msg("assistant", ["a"])])])
        note_src = note_path(self.staging, "chatgpt-conv-ab.md")
        data = open(note_src, "rb").read()
        dup_path = note_path(self.staging, "chatgpt-conv-ab-dup.md")
        with open(dup_path, "wb") as fh:
            fh.write(data)
        manifest_path = os.path.join(self.staging, "import-manifest.json")
        man = read_json(manifest_path)
        entry = [c for c in man["conversations"] if c["conversation_id"] == "conv-ab"][0]
        dup = dict(entry)
        dup["note"] = "notes/chatgpt-conv-ab-dup.md"
        man["conversations"].append(dup)
        man["notes"]["notes/chatgpt-conv-ab-dup.md"] = dict(
            man["notes"]["notes/chatgpt-conv-ab.md"])
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(man, fh)
        with self.assertRaises(promote_mod.PromotionError):
            self.promote(apply=False)   # ambiguous authority refused on any read
        self.assertFalse(os.path.exists(self.target))

    def test_r2d_target_staging_overlap_refused_both_directions(self):
        self.import_zip([linear_conv("conv-o", "O", [msg("user", ["q"])])])
        # target == staging
        with self.assertRaises(promote_mod.PromotionError):
            self.promote_to(self.staging, apply=False)
        # target nested inside staging
        with self.assertRaises(promote_mod.PromotionError):
            self.promote_to(os.path.join(self.staging, "sub"), apply=False)
        # staging nested inside target (reverse overlap)
        with self.assertRaises(promote_mod.PromotionError):
            self.promote_to(self.tmp, apply=False)
        # symlink alias of staging as target
        alias = os.path.join(self.tmp, "staging-alias")
        os.symlink(self.staging, alias)
        with self.assertRaises(promote_mod.PromotionError):
            self.promote_to(alias, apply=False)
        self.assertFalse(os.path.exists(os.path.join(self.staging, "sub")))
        # staging never gained promotion artifacts
        listing = set(os.listdir(self.staging))
        self.assertNotIn("promote-manifest.json", listing)
        self.assertNotIn("sub", listing)
        self.assertIn("import-manifest.json", listing)
        self.assertIn("notes", listing)

if __name__ == "__main__":
    unittest.main()