import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError

import app
import drafts
import novel
import test_workbench as support


class DraftStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "drafts.sqlite3"
        self.db = sqlite3.connect(self.path)
        drafts.init(self.db)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def call(self, action="read", key="dialog:entity-form:character:new", value=None, version=0, pid="project-1"):
        return drafts.handle(self.db, pid, {"action": action, "key": key, "value": value, "expected_version": version})["draft"]

    def test_round_trip_after_reopening_and_isolation(self):
        value = {"fields": {"name": [{"value": "雨港来客😀"}], "locked": [{"value": "on", "checked": True}]}}
        self.assertEqual(self.call()["version"], 0)
        self.assertEqual(self.call("write", value=value)["version"], 1)
        self.assertEqual(self.call()["value"], value)
        self.assertIsNone(self.call(pid="project-2")["value"])
        self.db.commit()
        self.db.close()
        self.db = sqlite3.connect(self.path)
        drafts.init(self.db)
        self.assertEqual(self.call()["value"], value)
        self.assertEqual(drafts.list_drafts(self.db, "project-1")["drafts"][0]["value"], value)

    def test_delete_keeps_tombstone_and_blocks_stale_resurrection(self):
        self.call("write", value={"notes": "旧草稿"})
        self.call("delete", version=1)
        self.assertIsNone(self.call()["value"])
        self.assertEqual(self.call()["version"], 2)
        self.assertEqual(drafts.list_drafts(self.db, "project-1"), {"drafts": []})
        for stale in (0, 1):
            with self.subTest(version=stale), self.assertRaises(drafts.DraftConflict):
                self.call("write", value={"notes": "旧窗口输入"}, version=stale)
        self.call("write", value={"notes": "新输入"}, version=2)
        self.assertEqual(self.call()["value"], {"notes": "新输入"})

    def test_private_or_non_json_fields_are_rejected_recursively(self):
        for field in ("api_key", "PASSWORD", "base64", "file_path", "access-token", "authorization", "credentials"):
            with self.subTest(field=field), self.assertRaises(novel.StoryError):
                self.call("write", value={"nested": [{field: "must-not-save"}]})
        for value in ([], None, {"number": float("nan")}, {"number": float("inf")}, {"bad": set()}):
            with self.subTest(value=repr(value)), self.assertRaises(novel.StoryError):
                self.call("write", value=value)
        self.assertEqual(self.call()["version"], 0)

    def test_size_is_utf8_bytes_and_failed_write_keeps_old_value(self):
        good = {"sourceText": "文" * 100000, "original": "原" * 20000, "replacement": "改" * 30000,
                "edit": {"original": "原" * 20000, "replacement": "改" * 30000}, "alternative": "另" * 30000}
        self.call("write", value=good)
        with self.assertRaises(novel.StoryError):
            self.call("write", value={"text": "文" * 400001}, version=1)
        self.assertEqual(self.call()["value"], good)
        self.assertEqual(self.call()["version"], 1)

    def test_active_limit_excludes_tombstones(self):
        for index in range(100):
            self.call("write", key=f"proposal:plan:{index}", value={"text": "计划"})
        with self.assertRaises(novel.StoryError):
            self.call("write", key="proposal:plan:overflow", value={"text": "未保存"})
        self.call("delete", key="proposal:plan:0", version=1)
        self.call("write", key="proposal:plan:overflow", value={"text": "可保存"})
        self.assertEqual(len(drafts.list_drafts(self.db, "project-1")["drafts"]), 100)

    def test_full_memory_candidates_have_a_larger_but_bounded_draft_budget(self):
        value = {"summary": "事实摘要", "changes": [{"value": "状" * 5000, "evidence": "据" * 5000} for _ in range(100)]}
        self.assertGreater(len(json.dumps(value, ensure_ascii=False).encode()), drafts.MAX_VALUE_BYTES)
        saved = self.call("write", key="memory:chapter", value=value)
        self.assertEqual(saved["value"], value)
        with self.assertRaises(novel.StoryError):
            self.call("write", key="dialog:oversize", value=value)
        with self.assertRaises(novel.StoryError):
            self.call("write", key="memory:chapter", value={"text": "x" * drafts.MAX_MEMORY_VALUE_BYTES}, version=1)
        self.assertEqual(self.call(key="memory:chapter")["value"], value)

    def test_project_quota_counts_actual_utf8_and_can_replace_existing(self):
        for index in range(34):
            self.call("write", key=f"large:{index}", value={"text": "x" * 580000})
        with self.assertRaises(novel.StoryError):
            self.call("write", key="large:35", value={"text": "x" * 580000})
        self.call("write", key="large:0", value={"text": "缩短"}, version=1)
        self.call("write", key="large:35", value={"text": "x" * 580000})

    def test_keys_and_expected_versions_require_explicit_valid_values(self):
        for key in ("", "../../bad", "bad key", "a" * 181, None):
            with self.subTest(key=key), self.assertRaises(novel.StoryError):
                self.call("write", key=key, value={})
        for version in (None, True, -1, "0"):
            with self.subTest(version=version), self.assertRaises(novel.StoryError):
                self.call("write", value={}, version=version)


class DraftHTTPTests(unittest.TestCase):
    setUp = support.HTTPTests.setUp
    tearDown = support.HTTPTests.tearDown
    request = support.HTTPTests.request

    def test_endpoint_does_not_mutate_revision_and_survives_store_restart(self):
        before = self.server.store.get(self.pid)
        key = "dialog:style-reference-form:new"
        body = {"action": "write", "key": key, "value": {"notes": "保留短句节奏"}, "expected_version": 0}
        code, raw = self.request(f"/api/projects/{self.pid}/drafts", body)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["draft"]["version"], 1)
        self.assertEqual(self.server.store.get(self.pid), before)
        self.server.store = app.Store(self.server.store.path)
        _, raw = self.request(f"/api/projects/{self.pid}/drafts", {"action": "read", "key": key})
        self.assertEqual(json.loads(raw)["draft"]["value"], body["value"])
        _, raw = self.request(f"/api/projects/{self.pid}/drafts")
        self.assertEqual(len(json.loads(raw)["drafts"]), 1)
        with self.assertRaises(HTTPError) as caught:
            self.request(f"/api/projects/{self.pid}/drafts", body)
        self.assertEqual(caught.exception.code, 409)
        with self.assertRaises(HTTPError):
            self.request("/api/projects/missing/drafts", body)


if __name__ == "__main__":
    unittest.main()
