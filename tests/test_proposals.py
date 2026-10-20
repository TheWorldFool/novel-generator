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


if __name__ == "__main__":
    unittest.main()
