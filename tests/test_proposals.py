import copy
import unittest

import novel
import proposals
import outline


def source_outline():
    return {"text": "收到信，调查港口，最终公开证据。", "ending": "公开证据", "guardrails": "不改变结局", "nodes": [
        {"id": "author-node", "title": "作者手改节点", "goal": "拿到证据", "must": "调查", "avoid": "不跳跃", "source_quote": "调查港口"}]}


def model_outline():
    return {"text": "模型不应覆盖", "ending": "模型不应改变结局", "nodes": [
        {"title": "收到信", "goal": "决定出发", "must": "收到信", "avoid": "不提前揭底", "source_quote": "收到信"},
        {"title": "公开证据", "goal": "真相公开", "must": "找到证据", "avoid": "不改结局", "source_quote": "最终公开证据"}]}


class ProposalTests(unittest.TestCase):
    def setUp(self):
        self.p = novel.upgrade(novel.demo_project())
        outline.mutate(self.p, "save_book_outline", source_outline())
        self.c = self.p["chapters"][1]

    def outline_data(self, preview, mode="replace"):
        return {"source_revision": preview["source_revision"], "source_hash": preview["source_hash"],
                "mode": mode, "draft": copy.deepcopy(preview["draft"])}

    def test_outline_generation_is_read_only_and_preserves_author_direction(self):
        before = copy.deepcopy(self.p)
        candidate = proposals.outline_preview(self.p, model_outline())
        self.assertEqual(self.p, before)
        self.assertEqual(candidate["original"], source_outline())
        self.assertEqual(candidate["draft"]["text"], source_outline()["text"])
        self.assertEqual(candidate["draft"]["ending"], source_outline()["ending"])
        self.assertTrue(all(node["id"] != "author-node" for node in candidate["draft"]["nodes"]))
        candidate["original"]["nodes"][0]["goal"] = "客户端改动"
        self.assertEqual(self.p["book_outline"]["draft"], source_outline())

    def test_select_and_manually_edit_one_node_then_restore_exact_author_draft(self):
        preview = proposals.outline_preview(self.p, model_outline())
        data = self.outline_data(preview)
        data["draft"]["nodes"] = data["draft"]["nodes"][:1]
        data["draft"]["nodes"][0]["title"] = "作者改过的候选"
        data["draft"].update(text="不能替换原文", ending="不能替换结局", guardrails="不能替换约束")
        active = copy.deepcopy(self.p["book_outline"]["active"])
        proposals.adopt_outline(self.p, data)
        book = self.p["book_outline"]
        self.assertEqual(book["draft"]["nodes"][0]["title"], "作者改过的候选")
        self.assertEqual(len(book["draft"]["nodes"]), 1)
        for field in ("text", "ending", "guardrails"):
            self.assertEqual(book["draft"][field], source_outline()[field])
        self.assertEqual(book["active"], active)
        old = copy.deepcopy(book["draft_history"][0])
        self.assertEqual(old["draft"], source_outline())
        proposals.restore_outline_draft(self.p, {"history_id": old["id"]})
        self.assertEqual(book["draft"], source_outline())
        self.assertEqual(book["active"], active)
        self.assertEqual(book["draft_history"][-1]["draft"]["nodes"][0]["title"], "作者改过的候选")

    def test_append_preserves_manual_nodes_and_validation_is_atomic(self):
        preview = proposals.outline_preview(self.p, model_outline())
        data = self.outline_data(preview, "append")
        proposals.adopt_outline(self.p, data)
        self.assertEqual(self.p["book_outline"]["draft"]["nodes"][0], source_outline()["nodes"][0])
        self.assertEqual(len(self.p["book_outline"]["draft"]["nodes"]), 3)
        before = copy.deepcopy(self.p)
        invalid = self.outline_data(proposals.outline_preview(self.p, model_outline()))
        invalid["draft"]["nodes"] = []
        with self.assertRaisesRegex(novel.StoryError, "至少选择"):
            proposals.adopt_outline(self.p, invalid)
        self.assertEqual(self.p, before)

    def test_stale_revision_and_hash_cannot_replace_author_edits(self):
        preview = proposals.outline_preview(self.p, model_outline())
        data = self.outline_data(preview)
        data["source_revision"] += 1
        with self.assertRaisesRegex(novel.StoryError, "过期"):
            proposals.adopt_outline(self.p, data)
        data["source_revision"] = self.p["revision"]
        self.p["book_outline"]["draft"]["nodes"][0]["goal"] = "生成后手改"
        with self.assertRaisesRegex(novel.StoryError, "过期"):
            proposals.adopt_outline(self.p, data)
        self.assertEqual(self.p["book_outline"]["draft"]["nodes"][0]["goal"], "生成后手改")

    def test_invalid_model_output_never_modifies_draft(self):
        before = copy.deepcopy(self.p)
        for result in ({}, {"nodes": ["bad"]}, {"nodes": [{"title": "缺少目标"}]},
                       {"nodes": [{"title": "错引", "goal": "目标", "source_quote": "不存在的原文"}]}):
            with self.assertRaises(novel.StoryError):
                proposals.outline_preview(self.p, result)
            self.assertEqual(self.p, before)

    def test_draft_history_retains_twenty_recent_checkpoints(self):
        book = self.p["book_outline"]
        for i in range(25):
            book["draft"]["ending"] = str(i)
            proposals.checkpoint_outline(book, "采用前")
        self.assertEqual(len(book["draft_history"]), 20)
        self.assertEqual(book["draft_history"][0]["draft"]["ending"], "5")

    def test_scene_generation_is_read_only_and_adoption_preserves_previous_plan(self):
        before = copy.deepcopy(self.p)
        preview = proposals.plan_preview(self.p, self.c, {"outline": "候选方案"})
        self.assertEqual(self.p, before)
        preview["outline"] = "作者改好的方案"
        proposals.adopt_plan(self.p, preview)
        self.assertEqual(self.c["outline"], "作者改好的方案")
        self.assertEqual(self.c["text"], before["chapters"][1]["text"])
        self.assertEqual(self.c["versions"][-1]["outline"], before["chapters"][1]["outline"])
        self.assertEqual(self.c["status"], before["chapters"][1]["status"])

    def test_stale_scene_source_is_rejected_without_partial_changes(self):
        preview = proposals.plan_preview(self.p, self.c, {"outline": "候选"})
        self.c["outline"] = "生成后作者手改"
        before = copy.deepcopy(self.p)
        with self.assertRaisesRegex(novel.StoryError, "过期"):
            proposals.adopt_plan(self.p, preview)
        self.assertEqual(self.p, before)

    def test_empty_scene_output_and_adoption_leave_original_intact(self):
        before = copy.deepcopy(self.p)
        with self.assertRaises(novel.StoryError):
            proposals.plan_preview(self.p, self.c, {"outline": " "})
        preview = proposals.plan_preview(self.p, self.c, {"outline": "候选"})
        preview["outline"] = " "
        with self.assertRaises(novel.StoryError):
            proposals.adopt_plan(self.p, preview)
        self.assertEqual(self.p, before)

    def rewrite_result(self):
        return {"text": "林照收起信，离开船厂。", "summary": "林照带信离开船厂。", "changes": [{
            "entity_id": self.p["entities"][0]["id"], "field": "location", "value": "船厂外", "evidence": "离开船厂", "selected": True}]}

    def rewrite_preview(self):
        self.c.update(text="林照站在船厂门口。", summary="林照在船厂。")
        return proposals.rewrite_preview(self.p, self.c, self.rewrite_result())

    def test_rewrite_preview_keeps_original_and_model_selections_are_not_author_selections(self):
        self.c.update(text="林照站在船厂门口。", summary="林照在船厂。")
        before = copy.deepcopy(self.p)
        preview = proposals.rewrite_preview(self.p, self.c, self.rewrite_result())
        self.assertEqual(self.p, before)
        self.assertEqual(preview["original"]["text"], self.c["text"])
        self.assertFalse(preview["changes"][0]["selected"])
        preview["original"]["changes"].append({"value": "客户端"})
        self.assertEqual(self.p, before)

    def test_rewrite_invalid_model_states_are_excluded_with_visible_warnings(self):
        preview = self.rewrite_preview()
        result = self.rewrite_result()
        result["changes"] += [{**result["changes"][0], "evidence": "不存在"},
                              {**result["changes"][0], "entity_id": "unknown"},
                              {**result["changes"][0]}, "wrong"]
        before = copy.deepcopy(self.p)
        preview = proposals.rewrite_preview(self.p, self.c, result)
        self.assertEqual(len(preview["changes"]), 1)
        self.assertEqual(len(preview["warnings"]), 4)
        self.assertEqual(self.p, before)

    def test_adopt_rewrite_saves_exact_manual_text_and_memory_with_checkpoint_and_separate_approval(self):
        preview = self.rewrite_preview()
        original = copy.deepcopy(self.c)
        preview["text"] = "林照收好信，离开船厂。"
        preview["summary"] = "作者核对：林照离开。"
        preview["changes"][0]["selected"] = True
        proposals.adopt_rewrite(self.p, preview)
        self.assertEqual(self.c["text"], preview["text"])
        self.assertEqual(self.c["summary"], preview["summary"])
        self.assertTrue(self.c["changes"][0]["selected"])
        self.assertEqual(self.c["status"], "draft")
        self.assertTrue(self.c["local_edit_review_required"])
        for key in ("text", "summary", "changes", "outline", "intent", "cast"):
            self.assertEqual(self.c["versions"][-1][key], original[key])
        for key in ("accepted_text", "accepted_summary", "accepted_changes", "node_id", "completes_node"):
            self.assertEqual(self.c.get(key), original.get(key))

    def test_adopting_approved_rewrite_invalidates_later_chapters_without_changing_accepted_memory(self):
        self.c = self.p["chapters"][0]
        later = self.p["chapters"][1]
        later.update(status="approved", accepted_text="原来确认的后章", review={"overview": "旧审稿"})
        accepted = copy.deepcopy(self.c["accepted_changes"])
        preview = proposals.rewrite_preview(self.p, self.c, self.rewrite_result())
        proposals.adopt_rewrite(self.p, preview)
        self.assertEqual(self.c["status"], "needs_review")
        self.assertEqual(later["status"], "needs_review")
        self.assertTrue(later["review"]["stale"])
        self.assertEqual(self.c["accepted_changes"], accepted)
        self.assertNotEqual(self.c["accepted_text"], self.c["text"])

    def test_stale_rewrite_revision_or_changed_source_is_atomic(self):
        preview = self.rewrite_preview()
        for key, value in (("source_revision", self.p["revision"] + 1), ("source_revision", True), ("source_hash", "changed")):
            bad = {**preview, key: value}
            before = copy.deepcopy(self.p)
            with self.assertRaisesRegex(novel.StoryError, "过期"):
                proposals.adopt_rewrite(self.p, bad)
            self.assertEqual(self.p, before)
        self.c["summary"] = "作者在生成后修改摘要"
        before = copy.deepcopy(self.p)
        with self.assertRaisesRegex(novel.StoryError, "过期"):
            proposals.adopt_rewrite(self.p, preview)
        self.assertEqual(self.p, before)

    def test_invalid_selected_rewrite_state_and_missing_memory_never_overwrite(self):
        preview = self.rewrite_preview()
        invalid = []
        for key, value in (("text", " "), ("summary", " "), ("changes", None)):
            invalid.append({**copy.deepcopy(preview), key: value})
        missing = copy.deepcopy(preview)
        del missing["changes"]
        invalid.append(missing)
        for changes in ([{**preview["changes"][0], "selected": True, "evidence": "不存在"}],
                        [{**preview["changes"][0], "selected": True, "evidence": " 离开船厂 "}],
                        [{**preview["changes"][0], "selected": True, "value": ""}],
                        [{**preview["changes"][0], "entity_id": "missing"}],
                        [preview["changes"][0], preview["changes"][0]]):
            invalid.append({**preview, "changes": changes})
        before = copy.deepcopy(self.p)
        for data in invalid:
            with self.assertRaises(novel.StoryError):
                proposals.adopt_rewrite(self.p, data)
            self.assertEqual(self.p, before)

    def test_unselected_incomplete_valid_targets_remain_editable(self):
        preview = self.rewrite_preview()
        preview["changes"][0].update(value="", evidence="待补依据", selected=False)
        proposals.adopt_rewrite(self.p, preview)
        self.assertEqual(self.c["changes"][0]["evidence"], "待补依据")
        self.assertFalse(self.c["changes"][0]["selected"])

    def test_empty_and_malformed_rewrite_model_output_preserves_original(self):
        self.rewrite_preview()
        before = copy.deepcopy(self.p)
        for result in (None, {}, {"text": "正文", "summary": ""},
                       {"text": "正文", "summary": "摘要", "changes": "bad"}):
            with self.assertRaises(novel.StoryError):
                proposals.rewrite_preview(self.p, self.c, result)
            self.assertEqual(self.p, before)
        self.c["text"] = " "
        with self.assertRaisesRegex(novel.StoryError, "先写入"):
            proposals.rewrite_preview(self.p, self.c, self.rewrite_result())

    def test_rewrite_noop_does_not_create_history_or_invalidation(self):
        self.rewrite_preview()
        preview = proposals.rewrite_preview(self.p, self.c, {"text": self.c["text"], "summary": self.c["summary"], "changes": []})
        before = copy.deepcopy(self.p)
        proposals.adopt_rewrite(self.p, preview)
        self.assertEqual(self.p, before)


if __name__ == "__main__":
    unittest.main()
