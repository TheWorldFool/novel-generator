"""Exercise structural edits and portable trash through the actual local API."""
import copy
import json
import unittest
from urllib.error import HTTPError

import app
import novel
import test_workbench as support


class ChapterWorkflowHTTPTests(unittest.TestCase):
    setUp = support.HTTPTests.setUp
    tearDown = support.HTTPTests.tearDown
    request = support.HTTPTests.request

    def mutate(self, p, action, data):
        _, raw = self.request(f"/api/projects/{p['id']}/mutate", {
            "revision": p["revision"], "action": action, "data": data})
        return json.loads(raw)["project"]

    def test_empty_chapter_can_be_removed_to_unblock_confirmation_and_restored(self):
        p = self.server.store.insert(novel.new_project("章节结构测试"))
        first_id = p["chapters"][0]["id"]
        p = self.mutate(p, "add_chapter", {})
        second_id = p["chapters"][1]["id"]
        p = self.mutate(p, "save_chapter", {"id": second_id, "text": "他推开门。", "summary": "他进屋。"})
        with self.assertRaises(HTTPError):
            self.mutate(p, "approve", {"id": second_id})
        self.assertEqual(self.server.store.get(p["id"]), p)
        p = self.mutate(p, "delete_chapter", {"id": first_id, "confirm_title": p["chapters"][0]["title"]})
        self.assertEqual([c["id"] for c in p["chapters"]], [second_id])
        self.assertEqual(p["chapter_trash"][0]["chapter"]["id"], first_id)
        p = self.mutate(p, "approve", {"id": second_id, "local_edit_checked": True})
        self.assertEqual(p["chapters"][0]["status"], "approved")
        p = self.mutate(p, "restore_chapter", {"trash_id": p["chapter_trash"][0]["id"]})
        self.assertEqual([c["id"] for c in p["chapters"]], [first_id, second_id])
        self.assertEqual(p["chapters"][1]["status"], "needs_review")
        self.assertEqual(p["chapters"][1]["text"], "他推开门。")
        self.assertEqual(p["chapter_trash"], [])
        with self.assertRaises(HTTPError):
            self.mutate(p, "approve", {"id": second_id, "local_edit_checked": True})

    def test_structure_actions_preserve_ids_and_reject_stale_or_invalid_operations_atomically(self):
        p = self.server.store.get(self.pid)
        first, second = p["chapters"]
        p = self.mutate(p, "insert_chapter", {"id": second["id"], "position": "before", "title": "补写的过渡章"})
        inserted = p["chapters"][1]
        self.assertEqual([c["id"] for c in p["chapters"]], [first["id"], inserted["id"], second["id"]])
        previous = copy.deepcopy(p)
        p = self.mutate(p, "move_chapter", {"id": inserted["id"], "direction": "up"})
        self.assertEqual([c["id"] for c in p["chapters"]], [inserted["id"], first["id"], second["id"]])
        self.assertEqual(p["chapters"][1]["text"], first["text"])
        self.assertEqual(p["chapters"][1]["status"], "needs_review")
        with self.assertRaises(HTTPError) as caught:
            self.mutate(previous, "delete_chapter", {"id": first["id"], "confirm_title": first["title"]})
        self.assertEqual(caught.exception.code, 409)
        for action, data in (("delete_chapter", {"id": first["id"], "confirm_title": "旧标题"}),
                             ("insert_chapter", {"id": second["id"], "position": "invalid"}),
                             ("move_chapter", {"id": second["id"], "direction": "invalid"}),
                             ("restore_chapter", {"trash_id": "missing"})):
            with self.subTest(action=action), self.assertRaises(HTTPError):
                self.mutate(p, action, data)
            self.assertEqual(self.server.store.get(self.pid), p)

    def test_backup_restores_deleted_chapter_and_all_history_without_activating_it(self):
        p = self.server.store.get(self.pid)
        original = copy.deepcopy(p["chapters"][0])
        p = self.mutate(p, "delete_chapter", {"id": original["id"], "confirm_title": original["title"]})
        _, raw = self.request(f"/api/projects/{self.pid}/backup")
        backup = json.loads(raw)
        self.assertEqual(backup["project"]["chapter_trash"][0]["chapter"]["text"], original["text"])
        _, raw = self.request("/api/backups/preview", backup)
        preview = json.loads(raw)["preview"]
        self.assertEqual(preview["chapter_count"], 1)
        self.assertEqual(preview["trashed_chapter_count"], 1)
        self.assertEqual(preview["version_count"], sum(len(c["versions"]) for c in p["chapters"])
                         + sum(len(t["chapter"]["versions"]) for t in p["chapter_trash"]))
        _, raw = self.request("/api/backups/import", backup)
        restored = json.loads(raw)["project"]
        self.assertNotEqual(restored["id"], self.pid)
        self.assertEqual(restored["chapter_trash"], p["chapter_trash"])
        self.assertEqual(restored["chapters"], p["chapters"])
        self.assertEqual(app.Store(self.server.store.path).get(restored["id"]), restored)
        restored = self.mutate(restored, "restore_chapter", {"trash_id": restored["chapter_trash"][0]["id"]})
        self.assertEqual(restored["chapters"][0]["id"], original["id"])
        self.assertEqual(restored["chapters"][0]["versions"], original["versions"])
        self.assertNotEqual(restored["chapters"][0]["status"], "approved")

    def test_legacy_backup_without_trash_still_restores_as_an_empty_recycle_bin(self):
        backup = self.server.store.backup(self.pid)
        backup["project"].pop("chapter_trash", None)
        before = copy.deepcopy(backup)
        _, raw = self.request("/api/backups/preview", backup)
        self.assertEqual(json.loads(raw)["preview"]["trashed_chapter_count"], 0)
        _, raw = self.request("/api/backups/import", backup)
        restored = json.loads(raw)["project"]
        self.assertEqual(restored["chapter_trash"], [])
        self.assertEqual(restored["chapters"], backup["project"]["chapters"])
        self.assertEqual(backup, before)

    def test_malformed_trash_cannot_be_imported_or_partially_create_a_book(self):
        p = self.server.store.get(self.pid)
        p = self.mutate(p, "delete_chapter", {"id": p["chapters"][0]["id"], "confirm_title": p["chapters"][0]["title"]})
        backup = self.server.store.backup(self.pid)
        before = self.server.store.list()
        mutations = [lambda t: t.update(index=True), lambda t: t.update(index=-1),
                     lambda t: t.update(deleted_at=[]), lambda t: t.update(chapter={}),
                     lambda t: t["chapter"].update(text=[]),
                     lambda t: t["chapter"].update(id=p["chapters"][0]["id"]),
                     lambda t: t["chapter"]["versions"][0].update(changes=[{"id": "bad"}])]
        for mutation in mutations:
            bad = copy.deepcopy(backup)
            mutation(bad["project"]["chapter_trash"][0])
            for route in ("/api/backups/preview", "/api/backups/import"):
                with self.subTest(route=route), self.assertRaises(HTTPError):
                    self.request(route, bad)
            self.assertEqual(self.server.store.list(), before)
            self.assertEqual(self.server.store.backup(self.pid), backup)


if __name__ == "__main__":
    unittest.main()
