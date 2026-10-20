import base64
import copy
import json
from http.client import HTTPConnection
from concurrent.futures import ThreadPoolExecutor
import sqlite3
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError

import app
import backups
import novel
import test_workbench as support
from test_references import PNG, character_result, style_result


class BackupStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = app.Store(Path(self.tmp.name) / "books.sqlite3")
        self.pid = self.store.list()[0]["id"]
        p = self.store.get(self.pid)
        ref, asset = app.prepare_image({"title": "人物原图", "base64": PNG,
                                        "entity_id": p["entities"][0]["id"]})
        self.rid = ref["id"]

        def populate(p):
            novel.add_image_reference(p, ref)
            novel.save_reference_analysis(p, self.rid, character_result())
            novel.save_reference_analysis(p, self.rid, character_result(), feedback="保留蓝色外套。")
            p["entities"][0]["reference_ids"] = [self.rid]
            novel.mutate(p, "save_style_reference", {"title": "写法参考", "text": "他放下杯子。窗外的雨还没停。"})
            novel.save_reference_analysis(p, p["references"][-1]["id"], style_result())
        self.store.update(self.pid, p["revision"], populate, image=asset)
        self.backup = self.store.backup(self.pid)

    def tearDown(self):
        self.tmp.cleanup()

    def test_preview_does_not_write_and_restores_complete_work_as_new_project(self):
        before = self.store.get(self.pid)
        _, _, preview = backups.prepare(self.backup, app.prepare_image)
        self.assertEqual(preview["chapter_count"], len(before["chapters"]))
        self.assertEqual(preview["image_count"], 1)
        self.assertEqual(preview["version_count"], sum(len(c["versions"]) for c in before["chapters"]))
        self.assertEqual(len(self.store.list()), 1)
        restored = self.store.restore_backup(self.backup)
        again = self.store.restore_backup(self.backup)
        self.assertEqual(len({self.pid, restored["id"], again["id"]}), 3)
        self.assertEqual(self.store.get(self.pid), before)
        self.assertEqual(restored["chapters"], before["chapters"])
        self.assertEqual(restored["book_outline"], before["book_outline"])
        self.assertEqual(restored["brief"], before["brief"])
        self.assertEqual(restored["style"], before["style"])
        self.assertEqual(restored["revision"], 0)
        self.assertFalse(restored["is_demo"])
        rid = restored["references"][0]["id"]
        self.assertNotEqual(rid, self.rid)
        self.assertNotEqual(rid, again["references"][0]["id"])
        self.assertEqual(restored["entities"][0]["reference_ids"], [rid])
        self.assertEqual(restored["references"][0]["analysis_history"], before["references"][0]["analysis_history"])
        self.assertEqual(self.store.image(restored["id"], rid)["data"], base64.b64decode(PNG))
        self.assertEqual([e["state"] for e in novel.canon(restored)], [e["state"] for e in novel.canon(before)])
        self.assertEqual([e["sources"] for e in novel.canon(restored)], [e["sources"] for e in novel.canon(before)])
        reopened = app.Store(self.store.path)
        self.assertEqual(reopened.get(restored["id"]), restored)
        self.assertEqual(reopened.backup(restored["id"])["images"][0]["base64"], PNG)
        self.assertEqual(self.backup, self.store.backup(self.pid))

    def test_invalid_backup_never_inserts_project_or_images(self):
        mutations = [
            lambda b: b.update(format="future-version"),
            lambda b: b.update(settings={"api_key": "must-not-import"}),
            lambda b: b["project"].update(api_key="must-not-import"),
            lambda b: b.update(images=[]),
            lambda b: b["images"].append(copy.deepcopy(b["images"][0])),
            lambda b: b["images"][0].update(base64="broken"),
            lambda b: b["images"][0].update(mime="image/jpeg"),
            lambda b: b["project"].update(chapters=[]),
            lambda b: b["project"]["entities"].append(copy.deepcopy(b["project"]["entities"][0])),
            lambda b: b["project"]["entities"][0].update(kind="unknown"),
            lambda b: b["project"]["entities"][0].update(id='bad" onclick="alert(1)'),
            lambda b: b["project"]["chapters"][0].update(id='bad" onclick="alert(1)'),
            lambda b: b["project"]["chapters"][0].update(text=["wrong"]),
            lambda b: b["project"]["chapters"][0].update(cast=["missing"]),
            lambda b: b["project"]["chapters"][0]["versions"][0].update(text={"invalid": True}),
            lambda b: b["project"]["references"][0]["analysis"].update(character=[]),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index):
                bad = copy.deepcopy(self.backup)
                mutate(bad)
                with self.assertRaises(novel.StoryError):
                    self.store.restore_backup(bad)
                self.assertEqual(self.store.backup(self.pid), self.backup)
                self.assertEqual(len(self.store.list()), 1)
                with self.store.connect() as db:
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM reference_images").fetchone()[0], 1)

    def test_image_write_failure_rolls_back_project_too(self):
        with self.store.connect() as db:
            db.execute("CREATE TRIGGER reject_restored_image BEFORE INSERT ON reference_images "
                       "BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.restore_backup(self.backup, "restore-failed-request-1")
        self.assertEqual(len(self.store.list()), 1)
        self.assertEqual(self.store.backup(self.pid), self.backup)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM backup_imports").fetchone()[0], 0)

    def test_import_retries_are_idempotent_across_concurrent_requests_and_restart(self):
        key = "same-restore-request-1234"
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: self.store.restore_backup(self.backup, key), range(2)))
        self.assertEqual(results[0]["id"], results[1]["id"])
        reopened = app.Store(self.store.path)
        reordered = json.loads(json.dumps(self.backup, sort_keys=True))
        self.assertEqual(reopened.restore_backup(reordered, key)["id"], results[0]["id"])
        self.assertEqual(len(reopened.list()), 2)
        with reopened.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM reference_images").fetchone()[0], 2)
        different = copy.deepcopy(self.backup)
        different["project"]["title"] = "另一份备份"
        with self.assertRaisesRegex(novel.StoryError, "改变"):
            reopened.restore_backup(different, key)
        self.assertEqual(len(reopened.list()), 2)

    def test_incomplete_nested_state_is_rejected_before_insertion(self):
        cases = []
        for field in ("text", "ending", "guardrails", "nodes"):
            backup = copy.deepcopy(self.backup)
            backup["project"]["book_outline"]["draft"].pop(field)
            cases.append(("draft missing " + field, backup))
        active = {"text": "source", "ending": "end", "guardrails": "", "nodes": [
            {"id": "node", "title": "stage", "goal": "goal", "must": "", "avoid": "", "source_quote": "source"}]}
        for field in ("text", "ending", "guardrails", "nodes"):
            backup = copy.deepcopy(self.backup)
            backup["project"]["book_outline"].update(active=copy.deepcopy(active), version=1)
            backup["project"]["book_outline"]["active"].pop(field)
            cases.append(("active missing " + field, backup))
        backup = copy.deepcopy(self.backup)
        backup["project"]["book_outline"].pop("active")
        cases.append(("missing active slot", backup))
        backup = copy.deepcopy(self.backup)
        backup["project"]["book_outline"]["active"] = {"text": "", "ending": "", "guardrails": "", "nodes": []}
        cases.append(("empty active direction", backup))
        backup = copy.deepcopy(self.backup)
        backup["project"]["chapters"][0].pop("review")
        cases.append(("missing review slot", backup))
        for value in ({}, {"analysis": None}):
            backup = copy.deepcopy(self.backup)
            backup["project"]["references"][0]["analysis_history"] = [value]
            cases.append(("incomplete reference analysis history", backup))
        for name, backup in cases:
            with self.subTest(case=name):
                with self.assertRaises(novel.StoryError):
                    self.store.restore_backup(backup)
                self.assertEqual(len(self.store.list()), 1)
                self.assertEqual(self.store.backup(self.pid), self.backup)

    def test_displayed_metadata_cannot_contain_objects_that_break_rendering(self):
        malformed = {"toString": "not a function"}
        cases = []
        for key in ("stale_reason", "stale_at"):
            backup = copy.deepcopy(self.backup)
            backup["project"]["chapters"][0]["review"] = {
                "source": "local", "at": novel.now(), "overview": "", "issues": [], "stale": True, key: malformed}
            cases.append(("review " + key, backup))
        for key in ("feedback", "at"):
            backup = copy.deepcopy(self.backup)
            backup["project"]["references"][0]["analysis"][key] = malformed
            cases.append(("analysis " + key, backup))
        backup = copy.deepcopy(self.backup)
        backup["project"]["references"][0]["applied_at"] = malformed
        cases.append(("reference applied_at", backup))
        for name, backup in cases:
            with self.subTest(case=name):
                with self.assertRaises(novel.StoryError):
                    self.store.restore_backup(backup)
                self.assertEqual(len(self.store.list()), 1)

    def test_old_optional_fields_and_legacy_versions_remain_readable(self):
        backup = copy.deepcopy(self.backup)
        p = backup["project"]
        for key in ("references", "style_reference_mode", "book_outline"):
            p.pop(key)
        for entity in p["entities"]:
            entity.pop("reference_ids", None)
        for c in p["chapters"]:
            for key in ("node_id", "completes_node", "node_evidence", "outline_checked_version", "local_edit_review_required"):
                c.pop(key, None)
        backup["images"] = []
        self.assertEqual(self.store.restore_backup(backup)["chapters"][0]["text"], p["chapters"][0]["text"])


class BackupHTTPTests(unittest.TestCase):
    setUp = support.HTTPTests.setUp
    tearDown = support.HTTPTests.tearDown
    request = support.HTTPTests.request

    def test_export_preview_import_and_reexport(self):
        _, raw = self.request(f"/api/projects/{self.pid}/backup")
        backup = json.loads(raw)
        code, raw = self.request("/api/backups/preview", backup)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["preview"]["title"], backup["project"]["title"])
        self.assertEqual(len(self.server.store.list()), 1)
        code, raw = self.request("/api/backups/import", backup)
        self.assertEqual(code, 201)
        restored = json.loads(raw)["project"]
        self.assertNotEqual(restored["id"], self.pid)
        _, raw = self.request(f"/api/projects/{restored['id']}/backup")
        self.assertEqual(json.loads(raw)["project"]["chapters"], backup["project"]["chapters"])

    def test_import_header_recovers_the_same_project_after_a_retry(self):
        backup = self.server.store.backup(self.pid)
        headers = {"Idempotency-Key": "http-restore-request-1234"}
        _, first = self.request("/api/backups/import", backup, headers)
        _, retry = self.request("/api/backups/import", backup, headers)
        self.assertEqual(json.loads(first)["project"]["id"], json.loads(retry)["project"]["id"])
        self.assertEqual(len(self.server.store.list()), 2)
        with self.assertRaises(HTTPError) as caught:
            self.request("/api/backups/import", backup, {"Idempotency-Key": "bad"})
        self.assertEqual(caught.exception.code, 400)

    def test_large_legitimate_backup_uses_its_own_limit(self):
        backup = self.server.store.backup(self.pid)
        c = backup["project"]["chapters"][0]
        template = {"at": novel.now(), "reason": "保留稿", "title": c["title"], "summary": c["summary"],
                    "outline": c["outline"], "text": "x" * 100000}
        c["versions"] = [{**template, "id": f"version-{i}"} for i in range(85)]
        self.assertGreater(len(json.dumps(backup).encode()), 8_000_000)
        self.request("/api/backups/preview", backup)
        code, _ = self.request("/api/backups/import", backup)
        self.assertEqual(code, 201)
        connection = HTTPConnection("127.0.0.1", self.server.server_port)
        try:
            connection.request("POST", "/api/projects", b"", {"Content-Type": "application/json", "Content-Length": "8000001"})
            self.assertEqual(connection.getresponse().status, 400)
        finally:
            connection.close()

    def test_invalid_preview_and_import_leave_database_unchanged(self):
        for route in ("preview", "import"):
            with self.subTest(route=route), self.assertRaises(HTTPError) as caught:
                self.request(f"/api/backups/{route}", {"format": backups.FORMAT, "project": {}, "images": []})
            self.assertEqual(caught.exception.code, 400)
        self.assertEqual(len(self.server.store.list()), 1)


if __name__ == "__main__":
    unittest.main()
