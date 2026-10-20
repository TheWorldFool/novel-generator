import copy
import hashlib
import json
import unittest

import memory
import novel


class MemoryDomainTests(unittest.TestCase):
    def setUp(self):
        self.p = novel.demo_project()
        self.c = self.p["chapters"][0]
        self.hero = self.p["entities"][0]

    def candidate(self, **updates):
        return {"id": "candidate", "entity_id": self.hero["id"], "field": "inventory",
                "value": "黄铜罗盘与来信", "evidence": "他把信折回原样，收进内袋。",
                "selected": True, **updates}

    def preview(self, **updates):
        result = {"summary": "林照收到来信后前往港务所。", "changes": [self.candidate()], **updates}
        return memory.preview(self.p, self.c, result)

    def test_context_uses_only_current_text_and_prior_confirmed_history(self):
        second = self.p["chapters"][1]
        second.update(text="本章正在发生的事。", intent="不能泄露的当前计划", outline="不能泄露的场景方案")
        self.p["brief"]["ending"] = "不能泄露的结局"
        future = novel.chapter("不能泄露的未来标题")
        future.update(text="不能泄露的未来正文", summary="不能泄露的未来摘要", status="approved",
                      accepted_text="不能泄露的未来定稿", accepted_summary="不能泄露的未来记忆",
                      accepted_changes=[self.candidate(field="location", value="未来位置")])
        self.p["chapters"].append(future)
        before = copy.deepcopy(self.p)
        context = memory.context(self.p, second)
        self.assertEqual(context["chapter"], {"title": second["title"], "text": second["text"]})
        self.assertEqual(context["previous_chapters"], [{"title": self.c["title"], "summary": self.c["accepted_summary"]}])
        self.assertEqual(context["entities"][0]["state"]["inventory"], self.c["accepted_changes"][0]["value"])
        self.assertNotIn("不能泄露", json.dumps(context, ensure_ascii=False))
        self.assertNotIn("未来位置", json.dumps(context, ensure_ascii=False))
        self.assertEqual(self.p, before)
        context["entities"][0]["state"]["inventory"] = "仅修改返回值"
        context["fields"]["character"].clear()
        self.assertNotEqual(self.p["entities"][0]["base"]["inventory"], "仅修改返回值")
        self.assertIn("inventory", novel.FIELDS["character"])

    def test_context_excludes_unconfirmed_previous_summary_and_state(self):
        self.c["status"] = "needs_review"
        second = self.p["chapters"][1]
        second["text"] = "继续调查。"
        context = memory.context(self.p, second)
        self.assertEqual(context["previous_chapters"], [])
        self.assertEqual(context["entities"][0]["state"], self.hero["base"])

    def test_preview_is_unselected_and_does_not_change_memory_or_body(self):
        before = copy.deepcopy(self.p)
        preview = self.preview(text="不得写入正文", intent="不得改变目标", summary="新摘要")
        self.assertEqual(preview["kind"], "memory")
        self.assertEqual(preview["source_revision"], self.p["revision"])
        self.assertEqual(preview["source_hash"], hashlib.sha256(self.c["text"].encode()).hexdigest())
        self.assertEqual(preview["original"], {"summary": self.c["summary"], "changes": self.c["changes"]})
        self.assertFalse(preview["changes"][0]["selected"])
        self.assertNotEqual(preview["changes"][0]["id"], "candidate")
        self.assertEqual(preview["warnings"], [])
        self.assertEqual(self.p, before)
        preview["original"]["changes"].clear()
        self.assertEqual(self.p, before)

    def test_invalid_model_candidates_are_excluded_with_individual_warnings(self):
        locked = self.p["entities"][2]
        changes = [self.candidate(),
                   self.candidate(entity_id="new-person"),
                   self.candidate(field="made-up"),
                   self.candidate(entity_id=locked["id"], field="fact"),
                   self.candidate(value="  "),
                   self.candidate(evidence="正文没有出现的依据"),
                   self.candidate(evidence=" "),
                   self.candidate(),
                   {"value": 4}, None]
        before = copy.deepcopy(self.p)
        preview = self.preview(changes=changes)
        self.assertEqual(len(preview["changes"]), 1)
        self.assertEqual(len(preview["warnings"]), len(changes) - 1)
        for index in range(2, len(changes) + 1):
            self.assertTrue(any(f"第{index}项" in warning for warning in preview["warnings"]))
        self.assertEqual(self.p, before)

    def test_invalid_summary_or_collection_fails_without_changes(self):
        before = copy.deepcopy(self.p)
        for result in (None, [], {}, {"summary": "有效"}, {"changes": []},
                       {"summary": "", "changes": []}, {"summary": None, "changes": []},
                       {"summary": "长" * 10001, "changes": []},
                       {"summary": "有效", "changes": {}},
                       {"summary": "有效", "changes": [{}] * 101}):
            with self.subTest(result_type=type(result).__name__), self.assertRaises(novel.StoryError):
                memory.preview(self.p, self.c, result)
            self.assertEqual(self.p, before)

    def test_manual_preview_retains_unfinished_rows_and_deselects_invalid_rows(self):
        self.c["changes"] = [self.candidate(id="valid"), self.candidate(id="duplicate"),
                             self.candidate(id="missing", entity_id="missing"),
                             self.candidate(id="badquote", evidence="旧正文依据"),
                             self.candidate(id="empty", value=""),
                             self.candidate(id="field", field="missing")]
        before = copy.deepcopy(self.p)
        preview = memory.current_preview(self.p, self.c)
        self.assertTrue(preview["manual"])
        self.assertEqual(len(preview["changes"]), 6)
        self.assertEqual([item["selected"] for item in preview["changes"]], [True] + [False] * 5)
        self.assertEqual(preview["changes"][3]["evidence"], "旧正文依据")
        self.assertEqual(len(preview["warnings"]), 5)
        self.assertEqual(self.p, before)

    def test_manual_preview_does_not_deselect_other_valid_fields(self):
        self.c["changes"] = [self.candidate(id="one"), self.candidate(id="two", field="goal")]
        preview = memory.current_preview(self.p, self.c)
        self.assertTrue(all(item["selected"] for item in preview["changes"]))
        self.assertEqual(preview["warnings"], [])

    def test_adopt_changes_only_memory_keeps_accepted_state_and_requires_confirmation(self):
        self.c.update(review={"overview": "旧审稿", "stale": False}, intent="目标不变", outline="方案不变",
                      node_id="node", node_evidence="信封是干的。", completes_node=True,
                      outline_checked_version=8)
        before = copy.deepcopy(self.c)
        preview = self.preview()
        preview["changes"][0]["selected"] = True
        memory.adopt(self.p, {**preview, "text": "恶意替换正文", "intent": "恶意替换目标",
                              "outline": "恶意替换方案", "cast": [], "node_id": "other"})
        for key in ("text", "title", "intent", "outline", "cast", "node_id", "node_evidence", "completes_node",
                    "outline_checked_version", "accepted_text", "accepted_summary", "accepted_changes"):
            self.assertEqual(self.c[key], before[key], key)
        self.assertEqual(self.c["summary"], preview["summary"])
        self.assertEqual(self.c["changes"], preview["changes"])
        self.assertEqual(self.c["status"], "needs_review")
        self.assertTrue(self.c["review"]["stale"])
        self.assertTrue(self.c["local_edit_review_required"])
        self.assertEqual(self.c["versions"][-1]["text"], before["text"])
        self.assertEqual(self.c["versions"][-1]["summary"], before["summary"])
        self.assertEqual(self.c["versions"][-1]["changes"], before["changes"])
        self.assertEqual(novel.canon(self.p)[0]["state"], self.hero["base"])

    def test_adopt_invalidates_downstream_but_does_not_change_it_or_earlier_chapters(self):
        second = self.p["chapters"][1]
        second.update(text="林照进门。", summary="林照进入港务所。", review={"overview": "第二章审稿"})
        novel.approve(self.p, second["id"])
        third = novel.chapter("第三章")
        third.update(text="他坐下。", summary="坐下。")
        self.p["chapters"].append(third)
        novel.approve(self.p, third["id"])
        before_first = copy.deepcopy(self.c)
        before_third = copy.deepcopy(third)
        preview = memory.preview(self.p, second, {"summary": "林照来到港务所。", "changes": []})
        memory.adopt(self.p, preview)
        self.assertEqual(self.c, before_first)
        self.assertEqual(second["status"], "needs_review")
        self.assertTrue(second["review"]["stale"])
        self.assertEqual(third["status"], "needs_review")
        for key in ("text", "summary", "changes", "accepted_text", "accepted_summary", "versions"):
            self.assertEqual(third[key], before_third[key])

    def test_stale_revision_or_hash_is_rejected_without_mutation(self):
        preview = self.preview()
        cases = [{**preview, "source_revision": -1}, {**preview, "source_revision": False},
                 {**preview, "source_revision": str(self.p["revision"])},
                 {**preview, "source_hash": "0" * 64}, {**preview, "source_hash": None},
                 {**preview, "chapter_id": "missing"}]
        before = copy.deepcopy(self.p)
        for data in cases:
            with self.subTest(data=data), self.assertRaises(novel.StoryError):
                memory.adopt(self.p, data)
            self.assertEqual(self.p, before)
        self.c["text"] += "作者又补了一句。"
        before = copy.deepcopy(self.p)
        with self.assertRaises(novel.StoryError):
            memory.adopt(self.p, preview)
        self.assertEqual(self.p, before)

    def test_all_adoption_validation_happens_before_snapshot_or_invalidation(self):
        preview = self.preview()
        cases = [self.candidate(entity_id="missing"), self.candidate(field="missing"),
                 self.candidate(value=""), self.candidate(evidence="不在正文"),
                 self.candidate(evidence=" 他把信折回原样，收进内袋。 "),
                 self.candidate(entity_id=self.p["entities"][2]["id"], field="fact")]
        before = copy.deepcopy(self.p)
        for change in cases:
            with self.subTest(change=change), self.assertRaises(novel.StoryError):
                memory.adopt(self.p, {**preview, "changes": [self.candidate(id="first", field="goal"), change]})
            self.assertEqual(self.p, before)
        for data in ({**preview, "summary": None}, {**preview, "changes": None},
                     {**preview, "changes": [self.candidate(id="same"), self.candidate(id="same", field="goal")]},
                     {**preview, "changes": [self.candidate(id="one"), self.candidate(id="two")]},
                     {key: value for key, value in preview.items() if key != "changes"}):
            with self.subTest(data=data), self.assertRaises(novel.StoryError):
                memory.adopt(self.p, data)
            self.assertEqual(self.p, before)

    def test_unselected_unfinished_candidates_can_be_saved_but_invalid_targets_cannot(self):
        preview = self.preview()
        locked = self.p["entities"][2]
        changes = [self.candidate(id="unfinished", value="", evidence="待补充", selected=False),
                   self.candidate(id="locked", entity_id=locked["id"], field="fact", selected=False)]
        memory.adopt(self.p, {**preview, "changes": changes})
        self.assertEqual(self.c["changes"], changes)
        self.assertEqual(novel.validate_changes(self.p, self.c), [])
        before = copy.deepcopy(self.p)
        with self.assertRaises(novel.StoryError):
            memory.adopt(self.p, {**memory.current_preview(self.p, self.c),
                                  "changes": [self.candidate(entity_id="missing", selected=False)]})
        self.assertEqual(self.p, before)

    def test_empty_candidates_can_replace_old_memory_without_approving(self):
        preview = self.preview(changes=[])
        memory.adopt(self.p, preview)
        self.assertEqual(self.c["changes"], [])
        self.assertEqual(self.c["status"], "needs_review")
        self.assertTrue(self.c["accepted_changes"])
        self.assertTrue(self.c["local_edit_review_required"])

    def test_restore_checkpoint_recovers_old_memory_and_preserves_prose(self):
        before = copy.deepcopy(self.c)
        memory.adopt(self.p, self.preview())
        vid = self.c["versions"][-1]["id"]
        novel.mutate(self.p, "restore", {"id": self.c["id"], "version_id": vid})
        self.assertEqual(self.c["text"], before["text"])
        self.assertEqual(self.c["summary"], before["summary"])
        self.assertEqual(self.c["changes"], [{**item, "selected": False} for item in before["changes"]])
        self.assertTrue(self.c["local_edit_review_required"])
        self.assertEqual(self.c["status"], "needs_review")

    def test_unchanged_manual_memory_is_noop_and_preserves_existing_review_flag(self):
        self.c["local_edit_review_required"] = True
        preview = memory.current_preview(self.p, self.c)
        before = copy.deepcopy(self.p)
        memory.adopt(self.p, preview)
        self.assertEqual(self.p, before)

    def test_blank_body_cannot_be_used_to_invent_memory(self):
        self.c["text"] = " \n"
        before = copy.deepcopy(self.p)
        for operation in (lambda: memory.context(self.p, self.c),
                          lambda: memory.current_preview(self.p, self.c),
                          lambda: self.preview(),
                          lambda: memory.adopt(self.p, {"chapter_id": self.c["id"]})):
            with self.assertRaises(novel.StoryError):
                operation()
            self.assertEqual(self.p, before)


if __name__ == "__main__":
    unittest.main()
