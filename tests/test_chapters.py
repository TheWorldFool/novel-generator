import copy
import unittest

import novel


class ChapterManagementTests(unittest.TestCase):
    def setUp(self):
        self.p = novel.new_project("章节调整")
        self.p["entities"] = [{"id": "hero", "kind": "character", "name": "林照", "description": "修船匠", "base": {"location": "船厂"}, "locked": False}]
        self.p["chapters"] = [novel.chapter(title) for title in ("甲章", "乙章", "丙章")]
        for index, c in enumerate(self.p["chapters"]):
            c.update(text=f"林照来到{c['title']}。", summary=f"抵达{c['title']}。", cast=["hero"], node_id=f"node-{index}",
                     changes=[{"id": f"change-{index}", "entity_id": "hero", "field": "location", "value": c["title"], "evidence": f"林照来到{c['title']}。", "selected": True}])
            novel.approve(self.p, c["id"])
        for c in self.p["chapters"]:
            c.update(review={"overview": "旧审稿", "stale": False, "issues": []}, outline_checked_version=7)
        novel.upgrade(self.p)
        self.first, self.second, self.third = self.p["chapters"]

    def assert_unchanged_rejection(self, action, data, message):
        before = copy.deepcopy(self.p)
        with self.assertRaisesRegex(novel.StoryError, message):
            novel.mutate(self.p, action, data)
        self.assertEqual(self.p, before)

    def test_insert_before_invalidates_followers_and_keeps_ids_and_source(self):
        originals = copy.deepcopy(self.p["chapters"])
        novel.mutate(self.p, "insert_chapter", {"id": self.second["id"], "position": "before", "title": "插章"})
        chapters = self.p["chapters"]
        self.assertEqual([c["title"] for c in chapters], ["甲章", "插章", "乙章", "丙章"])
        self.assertEqual(chapters[0], originals[0])
        self.assertEqual(chapters[1]["status"], "draft")
        for c, original in zip(chapters[2:], originals[1:]):
            self.assertEqual(c["status"], "needs_review")
            self.assertTrue(c["review"]["stale"])
            self.assertTrue(c["local_edit_review_required"])
            self.assertEqual(c["outline_checked_version"], 0)
            for key in ("id", "title", "text", "summary", "cast", "changes", "node_id", "accepted_text", "accepted_summary", "accepted_changes", "versions"):
                self.assertEqual(c[key], original[key])
        self.assertEqual(novel.canon(self.p)[0]["state"]["location"], "甲章")
        with self.assertRaisesRegex(novel.StoryError, "顺序"):
            novel.approve(self.p, self.second["id"], local_edit_checked=True)

    def test_insert_after_last_keeps_all_existing_approvals(self):
        before = copy.deepcopy(self.p["chapters"])
        novel.mutate(self.p, "insert_chapter", {"id": self.third["id"], "position": "after", "title": "尾声"})
        self.assertEqual(self.p["chapters"][:-1], before)
        self.assertEqual(self.p["chapters"][-1]["title"], "尾声")
        self.assertEqual(novel.canon(self.p)[0]["state"]["location"], "丙章")

    def test_adjacent_move_marks_from_earliest_changed_position(self):
        first = copy.deepcopy(self.first)
        original_ids = [c["id"] for c in self.p["chapters"]]
        novel.mutate(self.p, "move_chapter", {"id": self.third["id"], "direction": "up"})
        self.assertEqual([c["id"] for c in self.p["chapters"]], [original_ids[0], original_ids[2], original_ids[1]])
        self.assertEqual(self.p["chapters"][0], first)
        self.assertEqual([c["status"] for c in self.p["chapters"]], ["approved", "needs_review", "needs_review"])
        self.assertEqual(novel.canon(self.p)[0]["state"]["location"], "甲章")
        novel.mutate(self.p, "move_chapter", {"id": self.third["id"], "direction": "down"})
        self.assertEqual([c["id"] for c in self.p["chapters"]], original_ids)
        self.assertEqual([c["status"] for c in self.p["chapters"]], ["approved", "needs_review", "needs_review"])

    def test_move_first_down_invalidates_all_and_draft_reviews_too(self):
        self.third["status"] = "draft"
        novel.mutate(self.p, "move_chapter", {"id": self.first["id"], "direction": "down"})
        self.assertEqual([c["status"] for c in self.p["chapters"]], ["needs_review", "needs_review", "draft"])
        self.assertTrue(all(c["review"]["stale"] for c in self.p["chapters"]))
        self.assertEqual(novel.canon(self.p)[0]["state"]["location"], "船厂")

    def test_delete_preserves_full_chapter_in_trash_and_invalidates_remaining(self):
        original = copy.deepcopy(self.first)
        novel.mutate(self.p, "delete_chapter", {"id": self.first["id"], "confirm_title": self.first["title"]})
        self.assertEqual(len(self.p["chapters"]), 2)
        entry = self.p["chapter_trash"][0]
        self.assertEqual(entry["chapter"], original)
        self.assertEqual(entry["index"], 0)
        self.assertTrue(entry["id"])
        self.assertTrue(entry["deleted_at"])
        self.assertEqual([c["status"] for c in self.p["chapters"]], ["needs_review", "needs_review"])
        self.assertEqual(novel.canon(self.p)[0]["state"]["location"], "船厂")
        self.assertNotIn(original["title"], [c["title"] for c in self.p["chapters"]])

    def test_deleting_last_does_not_invalidate_earlier_chapters(self):
        before = copy.deepcopy(self.p["chapters"][:-1])
        novel.mutate(self.p, "delete_chapter", {"id": self.third["id"], "confirm_title": self.third["title"]})
        self.assertEqual(self.p["chapters"], before)
        self.assertEqual(novel.canon(self.p)[0]["state"]["location"], "乙章")

    def test_restore_retains_original_id_and_history_but_never_auto_approves(self):
        original = copy.deepcopy(self.second)
        novel.mutate(self.p, "delete_chapter", {"id": self.second["id"], "confirm_title": self.second["title"]})
        trash_id = self.p["chapter_trash"][0]["id"]
        novel.mutate(self.p, "restore_chapter", {"trash_id": trash_id})
        restored = self.p["chapters"][1]
        self.assertEqual([c["title"] for c in self.p["chapters"]], ["甲章", "乙章", "丙章"])
        self.assertEqual(self.p["chapter_trash"], [])
        for key in ("id", "text", "summary", "changes", "accepted_text", "accepted_changes", "versions"):
            self.assertEqual(restored[key], original[key])
        self.assertEqual(restored["status"], "needs_review")
        self.assertTrue(restored["review"]["stale"])
        self.assertTrue(restored["local_edit_review_required"])
        self.assertEqual(novel.canon(self.p)[0]["state"]["location"], "甲章")
        with self.assertRaisesRegex(novel.StoryError, "核对章节摘要"):
            novel.approve(self.p, restored["id"])
        novel.approve(self.p, restored["id"], local_edit_checked=True)
        self.assertEqual(novel.canon(self.p)[0]["state"]["location"], "乙章")

    def test_restoring_original_position_clamps_after_directory_shrinks(self):
        novel.mutate(self.p, "delete_chapter", {"id": self.third["id"], "confirm_title": self.third["title"]})
        trash_id = self.p["chapter_trash"][0]["id"]
        novel.mutate(self.p, "delete_chapter", {"id": self.second["id"], "confirm_title": self.second["title"]})
        novel.mutate(self.p, "restore_chapter", {"trash_id": trash_id})
        self.assertEqual([c["id"] for c in self.p["chapters"]], [self.first["id"], self.third["id"]])
        self.assertEqual(self.p["chapters"][-1]["status"], "needs_review")

    def test_invalid_ids_arguments_and_boundaries_are_atomic(self):
        for action, data, message in [
            ("insert_chapter", {"id": "missing", "position": "before"}, "不存在"),
            ("insert_chapter", {"id": self.first["id"], "position": "other"}, "之前或之后"),
            ("insert_chapter", {"id": self.first["id"], "position": "before", "title": " "}, "标题不能为空"),
            ("move_chapter", {"id": self.first["id"], "direction": "up"}, "边界"),
            ("move_chapter", {"id": self.third["id"], "direction": "down"}, "边界"),
            ("move_chapter", {"id": self.first["id"], "direction": "sideways"}, "方向无效"),
            ("delete_chapter", {"id": self.first["id"]}, "核对"),
            ("delete_chapter", {"id": self.first["id"], "confirm_title": "其他章"}, "核对"),
            ("restore_chapter", {"trash_id": "missing"}, "没有"),
        ]:
            with self.subTest(action=action, data=data):
                self.assert_unchanged_rejection(action, data, message)

    def test_last_chapter_and_full_trash_are_protected(self):
        self.p["chapter_trash"] = [{"id": str(i), "chapter": novel.chapter(), "index": 0, "deleted_at": novel.now()} for i in range(30)]
        self.assert_unchanged_rejection("delete_chapter", {"id": self.first["id"], "confirm_title": self.first["title"]}, "回收站已满")
        self.p["chapters"] = [self.first]
        self.p["chapter_trash"] = []
        self.assert_unchanged_rejection("delete_chapter", {"id": self.first["id"], "confirm_title": self.first["title"]}, "至少需要保留一章")

    def test_duplicate_restoration_is_rejected_without_losing_trash(self):
        self.p["chapter_trash"] = [{"id": "duplicate", "chapter": copy.deepcopy(self.first), "index": 0, "deleted_at": novel.now()}]
        self.assert_unchanged_rejection("restore_chapter", {"trash_id": "duplicate"}, "不能重复恢复")

    def test_legacy_upgrade_initializes_trash_and_optional_fields(self):
        del self.p["chapter_trash"]
        novel.upgrade(self.p)
        self.assertEqual(self.p["chapter_trash"], [])
        trashed = novel.chapter("旧稿")
        del trashed["local_edit_review_required"]
        self.p["chapter_trash"].append({"id": "old", "chapter": trashed, "index": 1, "deleted_at": novel.now()})
        novel.upgrade(self.p)
        self.assertFalse(trashed["local_edit_review_required"])
        before = copy.deepcopy(self.p)
        novel.upgrade(self.p)
        self.assertEqual(self.p, before)


if __name__ == "__main__":
    unittest.main()
