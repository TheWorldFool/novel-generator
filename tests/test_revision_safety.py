import copy
import datetime as dt
import unittest
from unittest.mock import patch

import novel


class RevisionSafetyTests(unittest.TestCase):
    def setUp(self):
        self.p = novel.demo_project()
        self.first, self.second = self.p["chapters"]

    def test_manual_fact_change_requires_review_and_discards_stale_evidence(self):
        original = copy.deepcopy(self.first)
        self.first.update(node_evidence="他把信折回原样，收进内袋。", outline_checked_version=3)
        updated = self.first["text"].replace("他把信折回原样，收进内袋。", "他把信交给沈砚。")
        novel.mutate(self.p, "save_chapter", {"id": self.first["id"], "text": updated})
        self.assertTrue(self.first["local_edit_review_required"])
        self.assertEqual(self.first["summary"], original["summary"])
        self.assertEqual(self.first["changes"], [{**original["changes"][1], "selected": False}])
        self.assertEqual(self.first["outline_checked_version"], 0)
        self.assertEqual(self.first["node_evidence"], "")
        with self.assertRaisesRegex(novel.StoryError, "摘要与状态"):
            novel.approve(self.p, self.first["id"])
        # A later save of the reviewed candidate can explicitly select it again.
        reviewed = copy.deepcopy(self.first["changes"])
        reviewed[0]["selected"] = True
        novel.mutate(self.p, "save_chapter", {"id": self.first["id"], "changes": reviewed,
                                             "summary": "林照把来信交给沈砚，随后前往港务所。"})
        novel.approve(self.p, self.first["id"], local_edit_checked=True)
        self.assertEqual(self.first["accepted_changes"], reviewed)
        self.assertFalse(self.first["local_edit_review_required"])

    def test_first_manual_draft_can_be_confirmed_without_redundant_review_gate(self):
        p = novel.new_project()
        c = p["chapters"][0]
        novel.mutate(p, "save_chapter", {"id": c["id"], "text": "他推开门。", "summary": "他进屋。"})
        self.assertFalse(c["local_edit_review_required"])
        novel.approve(p, c["id"])
        self.assertEqual(c["status"], "approved")
        novel.mutate(p, "save_chapter", {"id": c["id"], "text": "他没有推开门。"})
        self.assertTrue(c["local_edit_review_required"])

    def test_unapproved_existing_draft_also_requires_memory_review_after_edit(self):
        self.second.update(text="他走进港务所。", summary="他抵达港务所。")
        novel.mutate(self.p, "save_chapter", {"id": self.second["id"], "text": "他留在旧船厂。"})
        self.assertTrue(self.second["local_edit_review_required"])
        with self.assertRaisesRegex(novel.StoryError, "核对"):
            novel.approve(self.p, self.second["id"])

    def test_restoring_confirmed_version_recovers_state_candidates_and_node_mapping(self):
        self.first.update(node_id="investigation", completes_node=True,
                          node_evidence="他把信折回原样，收进内袋。", outline_checked_version=2)
        novel.approve(self.p, self.first["id"])
        version = copy.deepcopy(self.first["versions"][-1])
        saved_changes = copy.deepcopy(version["accepted_changes"])
        original_inventory = novel.canon(self.p)[0]["state"]["inventory"]
        novel.mutate(self.p, "save_chapter", {"id": self.first["id"], "text": "林照仍在船厂。",
                                             "node_id": "another-node", "completes_node": False,
                                             "node_evidence": "", "changes": []})
        novel.mutate(self.p, "restore", {"id": self.first["id"], "version_id": version["id"]})
        self.assertEqual(self.first["text"], version["text"])
        self.assertEqual(self.first["node_id"], "investigation")
        self.assertTrue(self.first["completes_node"])
        self.assertEqual(self.first["node_evidence"], version["node_evidence"])
        self.assertEqual(self.first["outline_checked_version"], 0)
        self.assertTrue(self.first["local_edit_review_required"])
        self.assertEqual(self.first["changes"], [{**item, "selected": False} for item in saved_changes])
        self.assertEqual(novel.canon(self.p)[0]["state"]["inventory"], self.p["entities"][0]["base"]["inventory"])
        for item in self.first["changes"]:
            item["selected"] = True
        novel.approve(self.p, self.first["id"], local_edit_checked=True)
        self.assertEqual(novel.canon(self.p)[0]["state"]["inventory"], original_inventory)

    def test_legacy_restore_has_no_invented_state_or_mapping_and_requires_review(self):
        version = {key: copy.deepcopy(self.first["versions"][0][key])
                   for key in ("id", "at", "reason", "text", "title", "summary", "outline")}
        self.first["versions"] = [version]
        self.first.update(node_id="new-binding", completes_node=True, node_evidence="未来依据")
        novel.mutate(self.p, "restore", {"id": self.first["id"], "version_id": version["id"]})
        self.assertEqual(self.first["changes"], [])
        self.assertEqual(self.first["node_id"], "")
        self.assertFalse(self.first["completes_node"])
        self.assertEqual(self.first["node_evidence"], "")
        self.assertTrue(self.first["local_edit_review_required"])
        self.assertIn("旧版历史", self.p["events"][0]["message"])

    def recovery_candidates(self, count):
        items = []
        for index in range((count + len(novel.FIELDS["character"]) - 1) // len(novel.FIELDS["character"])):
            entity = copy.deepcopy(self.p["entities"][0])
            entity.update(id=f"recovery-character-{index}", name=f"恢复核对角色{index}")
            self.p["entities"].append(entity)
            for field in novel.FIELDS["character"]:
                items.append({"id": f"candidate-{len(items)}", "entity_id": entity["id"], "field": field,
                              "value": f"工作候选{len(items)}", "evidence": "信封是干的。", "selected": True})
        return items[:count]

    def restore_candidate_fixture(self, working, accepted, same_text=True):
        self.first.update(changes=copy.deepcopy(working), accepted_changes=copy.deepcopy(accepted),
                          accepted_text=self.first["text"] if same_text else "另一版已确认正文。")
        novel.snapshot(self.first, "恢复候选测试检查点")
        source = copy.deepcopy(self.first["versions"][-1])
        novel.mutate(self.p, "restore", {"id": self.first["id"], "version_id": source["id"]})
        return source

    def test_restore_prefers_working_value_over_older_accepted_value_of_same_field(self):
        working = self.recovery_candidates(1)
        accepted = [{**working[0], "value": "旧确认值", "evidence": "他把信折回原样，收进内袋。"}]
        self.restore_candidate_fixture(working, accepted)
        self.assertEqual(self.first["changes"], [{**working[0], "selected": False}])
        self.assertNotIn("上限", self.p["events"][0]["message"])

    def test_restore_repairs_id_collision_when_adding_distinct_accepted_field(self):
        working, accepted = self.recovery_candidates(2)
        accepted["id"] = working["id"]
        self.restore_candidate_fixture([working], [accepted])
        self.assertEqual(len(self.first["changes"]), 2)
        self.assertEqual(len({item["id"] for item in self.first["changes"]}), 2)
        self.assertEqual([item["value"] for item in self.first["changes"]], [working["value"], accepted["value"]])
        self.assertTrue(all(item["selected"] is False for item in self.first["changes"]))

    def test_restore_at_candidate_limit_keeps_working_candidates_and_reports_omitted_accepted_item(self):
        items = self.recovery_candidates(101)
        source = self.restore_candidate_fixture(items[:100], [items[100]])
        self.assertEqual(self.first["changes"], [{**item, "selected": False} for item in items[:100]])
        self.assertEqual(len(self.first["changes"]), 100)
        self.assertIn("上限", self.p["events"][0]["message"])
        self.assertIn("1项", self.p["events"][0]["message"])
        retained_source = next(v for v in self.first["versions"] if v["id"] == source["id"])
        self.assertEqual(retained_source["accepted_changes"], [items[100]])

    def test_restore_invalid_working_evidence_does_not_consume_slot_for_valid_accepted_item(self):
        items = self.recovery_candidates(101)
        working = copy.deepcopy(items[:100])
        working[-1]["evidence"] = "当前恢复正文里没有这句。"
        self.restore_candidate_fixture(working, [items[100]])
        self.assertEqual(len(self.first["changes"]), 100)
        self.assertEqual(self.first["changes"][-1], {**items[100], "selected": False})
        self.assertNotIn("上限", self.p["events"][0]["message"])

    def test_restore_never_merges_accepted_state_from_different_prose(self):
        working, accepted = self.recovery_candidates(2)
        self.restore_candidate_fixture([working], [accepted], same_text=False)
        self.assertEqual(self.first["changes"], [{**working, "selected": False}])

    def test_rapid_edits_preserve_session_start_and_do_not_fill_history(self):
        original = self.first["text"]
        at = dt.datetime(2026, 10, 20, tzinfo=dt.timezone.utc)
        for index in range(120):
            with patch("novel.now", return_value=(at + dt.timedelta(seconds=index)).isoformat()):
                novel.mutate(self.p, "save_chapter", {"id": self.first["id"], "text": f"第{index}次修改。"})
        edits = [v for v in self.first["versions"] if v.get("kind") == "edit"]
        self.assertEqual(len(edits), 1)
        self.assertEqual(edits[0]["text"], original)
        self.assertTrue(any(v["reason"] == "作者确认正文" for v in self.first["versions"]))

    def test_ordinary_edits_cannot_evict_checkpoints_and_limits_apply_separately(self):
        checkpoint = self.first["versions"][0]["id"]
        at = dt.datetime(2026, 10, 20, tzinfo=dt.timezone.utc)
        for index in range(110):
            with patch("novel.now", return_value=(at + dt.timedelta(minutes=index * 6)).isoformat()):
                novel.mutate(self.p, "save_chapter", {"id": self.first["id"], "text": f"第{index}次修改。"})
        self.assertIn(checkpoint, [v["id"] for v in self.first["versions"]])
        self.assertEqual(sum(v.get("kind") == "edit" for v in self.first["versions"]), novel.HISTORY_EDIT_LIMIT)
        for index in range(80):
            novel.snapshot(self.first, f"关键检查点 {index}")
        self.assertEqual(sum(v.get("kind") == "checkpoint" for v in self.first["versions"]), novel.HISTORY_CHECKPOINT_LIMIT)
        self.assertEqual(len(self.first["versions"]), novel.HISTORY_EDIT_LIMIT + novel.HISTORY_CHECKPOINT_LIMIT)

    def test_checkpoint_starts_new_edit_session_and_snapshot_is_deep_copy(self):
        novel.mutate(self.p, "save_chapter", {"id": self.first["id"], "text": self.first["text"] + "\n风停了。"})
        novel.approve(self.p, self.first["id"], local_edit_checked=True)
        checkpoint = copy.deepcopy(self.first["versions"][-1])
        novel.mutate(self.p, "save_chapter", {"id": self.first["id"], "text": self.first["text"] + "\n他等着。"})
        self.assertEqual(sum(v.get("kind") == "edit" for v in self.first["versions"]), 2)
        self.first["changes"][0]["value"] = "新值"
        self.first["cast"].append("another-character")
        self.assertEqual(self.first["versions"][-2], checkpoint)

    def test_scene_plans_are_recoverable_before_manual_and_ai_replacement(self):
        original = self.second["outline"]
        novel.mutate(self.p, "save_chapter", {"id": self.second["id"], "outline": "作者精修的场景方案。"})
        self.assertEqual(self.second["versions"][-1]["outline"], original)
        self.assertEqual(self.second["versions"][-1]["kind"], "edit")
        novel.apply_ai(self.p, self.second["id"], "plan", {"outline": "另一份场景方案。"})
        self.assertEqual(self.second["versions"][-1]["outline"], "作者精修的场景方案。")
        previous_count = len(self.second["versions"])
        novel.apply_ai(self.p, self.second["id"], "plan", {"outline": "另一份场景方案。"})
        self.assertEqual(len(self.second["versions"]), previous_count)

    def test_repeated_manual_scene_edits_cannot_evict_author_checkpoints(self):
        checkpoint = self.first["versions"][0]["id"]
        for index in range(120):
            novel.mutate(self.p, "save_chapter", {"id": self.first["id"], "outline": f"手动精修方案{index}"})
        self.assertIn(checkpoint, [v["id"] for v in self.first["versions"]])
        self.assertEqual(sum(v.get("kind") == "edit" for v in self.first["versions"]), 1)

    def test_earlier_changes_mark_all_later_reviews_stale_and_recheck_replaces_them(self):
        self.second.update(text="他走进港务所。", summary="他抵达。")
        novel.apply_ai(self.p, self.second["id"], "review", {"overview": "与前文一致。", "issues": []})
        review = copy.deepcopy(self.second["review"])
        self.assertFalse(review["stale"])
        self.assertIn("source_revision", review)
        novel.mutate(self.p, "save_chapter", {"id": self.first["id"], "text": self.first["text"] + "\n父亲归来。"})
        self.assertTrue(self.second["review"]["stale"])
        self.assertEqual(self.second["review"]["overview"], review["overview"])
        self.assertIn("stale_reason", self.second["review"])
        novel.mutate(self.p, "preflight", {"id": self.second["id"]})
        self.assertFalse(self.second["review"]["stale"])


if __name__ == "__main__":
    unittest.main()
