"""Exercise draft recovery and explicit AI adoption through the real local API."""
import copy
import json
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

import app
import novel
import test_workbench as support


class DraftHTTPTests(unittest.TestCase):
    setUp = support.HTTPTests.setUp
    tearDown = support.HTTPTests.tearDown
    request = support.HTTPTests.request

    def draft(self, **data):
        _, raw = self.request(f"/api/projects/{self.pid}/drafts", data)
        return json.loads(raw)["draft"]

    def test_dialog_input_survives_reopened_store_without_changing_story_revision(self):
        before = self.server.store.get(self.pid)
        key = "dialog:entity-form:character:new"
        self.assertEqual(self.draft(action="read", key=key)["version"], 0)
        value = {"fields": {"name": "沈砚", "description": "未保存的人物小传"}, "locked": True}
        saved = self.draft(action="write", key=key, value=value, expected_version=0)
        self.assertEqual(saved["version"], 1)
        self.assertEqual(app.Store(self.server.store.path).draft(self.pid, {"action": "read", "key": key})["draft"]["value"], value)
        self.assertEqual(self.server.store.get(self.pid), before)
        # Auxiliary autosave must not make an ordinary chapter save stale.
        updated = self.server.store.update(self.pid, before["revision"], lambda p: p.update(title="正文工作继续"))
        self.assertEqual(updated["revision"], before["revision"] + 1)
        _, raw = self.request(f"/api/projects/{self.pid}/drafts")
        self.assertEqual(json.loads(raw)["drafts"][0]["value"], value)

    def test_delete_tombstone_blocks_old_window_from_resurrecting_saved_input(self):
        key = "local-edit:chapter"
        self.draft(action="write", key=key, value={"instructions": "精简对白"}, expected_version=0)
        deleted = self.draft(action="delete", key=key, expected_version=1)
        self.assertIsNone(deleted["value"])
        self.assertEqual(deleted["version"], 2)
        with self.assertRaises(HTTPError) as caught:
            self.draft(action="write", key=key, value={"instructions": "旧窗口"}, expected_version=1)
        self.assertEqual(caught.exception.code, 409)
        self.assertIsNone(self.draft(action="read", key=key)["value"])
        self.draft(action="write", key=key, value={"instructions": "新一轮"}, expected_version=2)
        self.assertEqual(self.draft(action="read", key=key)["value"]["instructions"], "新一轮")

    def test_projects_are_isolated_and_unknown_projects_leave_no_orphan_draft(self):
        key = "reference:shared"
        self.draft(action="write", key=key, value={"feedback": "长发"}, expected_version=0)
        other = self.server.store.insert(novel.new_project("另一本书"))
        _, raw = self.request(f"/api/projects/{other['id']}/drafts", {"action": "read", "key": key})
        self.assertIsNone(json.loads(raw)["draft"]["value"])
        with self.assertRaises(HTTPError) as caught:
            self.request("/api/projects/missing/drafts", {"action": "write", "key": key, "value": {}, "expected_version": 0})
        self.assertEqual(caught.exception.code, 400)
        with self.server.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM work_drafts WHERE project_id='missing'").fetchone()[0], 0)

    def test_drafts_reject_secrets_and_are_not_mixed_into_exported_official_work(self):
        key = "dialog:entity-form:new"
        with self.assertRaises(HTTPError) as caught:
            self.draft(action="write", key=key, value={"api_key": "must-not-persist"}, expected_version=0)
        self.assertEqual(caught.exception.code, 400)
        self.draft(action="write", key=key, value={"description": "UNFINISHED-PRIVATE-INPUT"}, expected_version=0)
        backup = self.server.store.backup(self.pid)
        self.assertNotIn("UNFINISHED-PRIVATE-INPUT", json.dumps(backup))
        self.assertNotIn("must-not-persist", json.dumps(self.server.store.drafts(self.pid)))


class ProposalHTTPTests(unittest.TestCase):
    setUp = support.HTTPTests.setUp
    tearDown = support.HTTPTests.tearDown
    request = support.HTTPTests.request
    enable_outline = support.HTTPTests.enable_outline

    def set_outline_ready(self):
        self.enable_outline()
        return self.server.store.get(self.pid)

    def test_scene_generation_is_only_preview_until_edited_candidate_is_adopted(self):
        before = self.set_outline_ready()
        chapter = before["chapters"][1]
        with patch("app.call_model", return_value={"outline": "模型候选方案"}):
            _, raw = self.request(f"/api/projects/{self.pid}/ai", {"revision": before["revision"], "action": "plan", "chapter_id": chapter["id"]})
        preview = json.loads(raw)["proposal"]
        self.assertEqual(self.server.store.get(self.pid), before)
        self.assertEqual(preview["original"], chapter["outline"])
        _, raw = self.request(f"/api/projects/{self.pid}/mutate", {"revision": before["revision"], "action": "apply_plan_proposal",
            "data": {**preview, "outline": "作者改过的候选方案"}})
        updated = json.loads(raw)["project"]
        current = updated["chapters"][1]
        self.assertEqual(current["outline"], "作者改过的候选方案")
        self.assertEqual(current["text"], chapter["text"])
        self.assertEqual(updated["book_outline"]["active"], before["book_outline"]["active"])
        self.assertTrue(any(v["outline"] == chapter["outline"] for v in current["versions"]))

    def test_outline_split_preserves_hand_nodes_and_adds_only_selected_candidates(self):
        p = self.set_outline_ready()
        def hand_edit(current):
            current["book_outline"]["draft"]["nodes"][0]["title"] = "精修的手工阶段"
        before = self.server.store.update(self.pid, p["revision"], hand_edit)
        draft = before["book_outline"]["draft"]
        result = {"ending": "模型不应覆盖的结局", "nodes": [
            {"title": "候选阶段", "goal": "追查线索", "must": "", "avoid": "", "source_quote": "林照收到来信后到港务所调查"}]}
        with patch("app.call_model", return_value=result):
            _, raw = self.request(f"/api/projects/{self.pid}/outline-ai", {"revision": before["revision"]})
        preview = json.loads(raw)["proposal"]
        self.assertEqual(self.server.store.get(self.pid), before)
        candidate = copy.deepcopy(preview["draft"])
        candidate["nodes"][0]["title"] = "作者改过的候选阶段"
        _, raw = self.request(f"/api/projects/{self.pid}/mutate", {"revision": before["revision"], "action": "apply_outline_proposal",
            "data": {"source_revision": preview["source_revision"], "source_hash": preview["source_hash"], "mode": "append", "draft": candidate}})
        updated = json.loads(raw)["project"]
        book = updated["book_outline"]
        self.assertEqual([n["title"] for n in book["draft"]["nodes"]], ["精修的手工阶段", "作者改过的候选阶段"])
        self.assertEqual(book["draft"]["text"], draft["text"])
        self.assertEqual(book["draft"]["ending"], draft["ending"])
        self.assertEqual(book["active"], before["book_outline"]["active"])
        self.assertEqual(book["draft_history"][-1]["draft"], draft)

    def test_concurrent_change_during_generation_and_stale_adoption_never_overwrite_work(self):
        before = self.set_outline_ready()
        chapter = before["chapters"][1]
        def competing(*args, **kwargs):
            self.server.store.update(self.pid, before["revision"], lambda p: p.update(title="等待期间的修改"))
            return {"outline": "迟到候选"}
        with patch("app.call_model", side_effect=competing), self.assertRaises(HTTPError) as caught:
            self.request(f"/api/projects/{self.pid}/ai", {"revision": before["revision"], "action": "plan", "chapter_id": chapter["id"]})
        self.assertEqual(caught.exception.code, 409)
        after = self.server.store.get(self.pid)
        self.assertEqual(after["title"], "等待期间的修改")
        self.assertEqual(after["chapters"][1]["outline"], chapter["outline"])
        with patch("app.call_model", return_value={"outline": "新候选"}):
            _, raw = self.request(f"/api/projects/{self.pid}/ai", {"revision": after["revision"], "action": "plan", "chapter_id": chapter["id"]})
        preview = json.loads(raw)["proposal"]
        latest = self.server.store.update(self.pid, after["revision"], lambda p: p["chapters"][1].update(outline="更新后的手工方案"))
        with self.assertRaises(HTTPError):
            self.request(f"/api/projects/{self.pid}/mutate", {"revision": latest["revision"], "action": "apply_plan_proposal", "data": preview})
        self.assertEqual(self.server.store.get(self.pid), latest)


if __name__ == "__main__":
    unittest.main()
