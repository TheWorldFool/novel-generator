import copy
import hashlib
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import novel
import test_workbench as support


def utf16_length(text):
    """Browser textarea offsets count UTF-16 units, rather than Python chars."""
    return len(text.encode("utf-16-le")) // 2


def selection(chapter, text, occurrence=0):
    position = -1
    for _ in range(occurrence + 1):
        position = chapter["text"].index(text, position + 1)
    return {"chapter_id": chapter["id"], "start": utf16_length(chapter["text"][:position]),
            "end": utf16_length(chapter["text"][:position + len(text)]), "selected_text": text}


class LocalEditDomainTests(unittest.TestCase):
    def setUp(self):
        self.p = novel.upgrade(novel.demo_project())
        self.c = self.p["chapters"][0]

    def preview(self, original, replacement, occurrence=0):
        return novel.edit_preview(self.p, self.c, selection(self.c, original, occurrence), {"replacement": replacement})

    def test_preview_carries_exact_source_and_has_no_side_effects(self):
        before = copy.deepcopy(self.p)
        edit = self.preview("信封是干的。", "信封仍然干燥。")
        self.assertEqual(edit["original"], "信封是干的。")
        self.assertEqual(edit["replacement"], "信封仍然干燥。")
        self.assertEqual(edit["chapter_id"], self.c["id"])
        self.assertEqual(edit["source_revision"], self.p["revision"])
        self.assertEqual(edit["source_hash"], hashlib.sha256(self.c["text"].encode("utf-8")).hexdigest())
        self.assertEqual(self.p, before)

    def test_duplicate_sentence_changes_only_selected_occurrence_with_emoji_offsets(self):
        self.c["text"] = "🌧️门外。\n他放下信。\n🕯️窗边。\n他放下信。\n原样保留🛶。"
        before = self.c["text"]
        original = "他放下信。"
        edit = self.preview(original, "他把信放进抽屉。", occurrence=1)
        self.assertGreater(edit["start"], before.rindex(original))
        novel.mutate(self.p, "apply_local_edit", edit)
        index = before.rindex(original)
        self.assertEqual(self.c["text"], before[:index] + "他把信放进抽屉。" + before[index + len(original):])
        self.assertIn("\n他放下信。\n", self.c["text"])
        self.assertEqual(self.c["text"].count(original), 1)

    def test_selection_can_contain_complete_supplementary_characters(self):
        self.c["text"] = "前🛶后🌧。"
        edit = self.preview("🛶", "船")
        self.assertEqual((edit["start"], edit["end"]), (1, 3))
        novel.apply_local_edit(self.p, edit)
        self.assertEqual(self.c["text"], "前船后🌧。")

    def test_invalid_and_split_surrogate_selections_are_rejected_without_changes(self):
        self.c["text"] = "前🛶后。"
        valid = selection(self.c, "🛶")
        cases = [
            {**valid, "start": 2}, {**valid, "end": 2},
            {**valid, "start": True}, {**valid, "end": 3.0},
            {**valid, "start": -1}, {**valid, "end": 99},
            {**valid, "start": 3, "end": 1}, {**valid, "end": valid["start"]},
            {**valid, "selected_text": "另一艘船"}, {**valid, "selected_text": None},
        ]
        before = copy.deepcopy(self.p)
        for data in cases:
            with self.subTest(data=data), self.assertRaises(novel.StoryError):
                novel.edit_selection(self.p, self.c, data)
            self.assertEqual(self.p, before)
        self.c["text"] = " \n\t"
        with self.assertRaises(novel.StoryError):
            novel.edit_selection(self.p, self.c, selection(self.c, self.c["text"]))

    def test_selection_and_replacement_limits_bound_resulting_chapter(self):
        self.c["text"] = "长" * 20001
        with self.assertRaises(novel.StoryError):
            novel.edit_selection(self.p, self.c, selection(self.c, self.c["text"]))
        self.c["text"] = "旧" + "保" * 99999
        for replacement in (None, 1, [], "长" * 30001, "两字"):
            with self.subTest(replacement_type=type(replacement).__name__), self.assertRaises(novel.StoryError):
                self.preview("旧", replacement)
        for result in ({}, [], None, {"text": "错误字段"}):
            with self.subTest(result=result), self.assertRaises(novel.StoryError):
                novel.edit_preview(self.p, self.c, selection(self.c, "旧"), result)

    def test_empty_replacement_intentionally_deletes_only_selection(self):
        self.c["text"] = "保留前文。删除这句。\n保留后文。"
        edit = self.preview("删除这句。", "")
        novel.mutate(self.p, "apply_local_edit", edit)
        self.assertEqual(self.c["text"], "保留前文。\n保留后文。")

    def test_stale_revision_hash_and_original_are_rejected_before_mutation(self):
        edit = self.preview("信封是干的。", "信封有一点湿。")
        before = copy.deepcopy(self.p)
        cases = [{**edit, "source_revision": self.p["revision"] - 1},
                 {**edit, "source_revision": False},
                 {**edit, "source_hash": "0" * 64},
                 {**edit, "original": "不一致的选中文字"}]
        for data in cases:
            with self.subTest(data=data), self.assertRaises(novel.StoryError):
                novel.mutate(self.p, "apply_local_edit", data)
            self.assertEqual(self.p, before)
        self.c["text"] += "正文已另行编辑。"
        before = copy.deepcopy(self.p)
        with self.assertRaises(novel.StoryError):
            novel.apply_local_edit(self.p, edit)
        self.assertEqual(self.p, before)

    def test_apply_preserves_summary_clears_stale_candidates_and_invalidates_canon(self):
        second = self.p["chapters"][1]
        hero = self.p["entities"][0]
        second.update(text="林照走进港务所。", summary="林照抵达港务所。", changes=[
            {"id": "move", "entity_id": hero["id"], "field": "location", "value": "港务所",
             "evidence": "林照走进港务所。", "selected": True}])
        novel.approve(self.p, second["id"])
        self.assertEqual(novel.canon(self.p)[0]["state"]["location"], "港务所")
        self.c.update(review={"overview": "过时审稿"}, outline_checked_version=4,
                      node_evidence="信封是干的。")
        before = copy.deepcopy(self.c)
        edit = self.preview("信封是干的。", "信封有一点湿。")
        novel.mutate(self.p, "apply_local_edit", edit)
        self.assertEqual([c["status"] for c in self.p["chapters"]], ["needs_review", "needs_review"])
        self.assertEqual(self.c["summary"], before["summary"])
        self.assertEqual(self.c["changes"], [{**change, "selected": False} for change in before["changes"]])
        self.assertIsNone(self.c["review"])
        self.assertTrue(self.c["local_edit_review_required"])
        self.assertEqual(self.c["outline_checked_version"], 0)
        self.assertEqual(self.c["node_evidence"], "")
        self.assertEqual(self.c["versions"][-1]["text"], before["text"])
        self.assertEqual(self.c["versions"][-1]["summary"], before["summary"])
        self.assertEqual(novel.canon(self.p)[0]["state"], hero["base"])

    def test_unchanged_state_evidence_is_retained_unselected_and_stale_evidence_removed(self):
        before = copy.deepcopy(self.c["changes"])
        selected_quote = "他把信折回原样，收进内袋。"
        self.assertEqual(before[0]["evidence"], selected_quote)
        novel.apply_local_edit(self.p, self.preview(selected_quote, "他犹豫了一下，把信交给沈砚。"))
        self.assertEqual(self.c["changes"], [{**before[1], "selected": False}])
        self.assertTrue(self.c["local_edit_review_required"])

    def test_unchanged_completion_evidence_survives_unrelated_edit(self):
        self.c["node_evidence"] = "他把信折回原样，收进内袋。"
        novel.apply_local_edit(self.p, self.preview("信封是干的。", "信封仍然干燥。"))
        self.assertEqual(self.c["node_evidence"], "他把信折回原样，收进内袋。")

    def test_confirmation_requires_explicit_summary_and_state_review(self):
        novel.apply_local_edit(self.p, self.preview("信封是干的。", "信封仍然干燥。"))
        with self.assertRaisesRegex(novel.StoryError, "摘要|状态"):
            novel.approve(self.p, self.c["id"])
        self.assertEqual(self.c["status"], "needs_review")
        novel.mutate(self.p, "approve", {"id": self.c["id"], "local_edit_checked": True})
        self.assertEqual(self.c["status"], "approved")
        self.assertFalse(self.c["local_edit_review_required"])

    def test_restore_recovers_original_and_keeps_adjusted_text_in_history(self):
        before = self.c["text"]
        novel.apply_local_edit(self.p, self.preview("信封是干的。", "信封有一点湿。"))
        adjusted = self.c["text"]
        original_version = self.c["versions"][-1]["id"]
        novel.mutate(self.p, "restore", {"id": self.c["id"], "version_id": original_version})
        self.assertEqual(self.c["text"], before)
        self.assertEqual(self.c["status"], "needs_review")
        self.assertTrue(any(version["text"] == adjusted for version in self.c["versions"]))
        self.assertEqual(self.c["changes"], [{**item, "selected": False} for item in self.c["versions"][-2]["changes"]])
        self.assertTrue(self.c["local_edit_review_required"])

    def test_unchanged_replacement_is_a_domain_noop(self):
        edit = self.preview("信封是干的。", "信封是干的。")
        before = copy.deepcopy(self.p)
        novel.apply_local_edit(self.p, edit)
        self.assertEqual(self.p, before)


class LocalEditHTTPTests(unittest.TestCase):
    setUp = support.HTTPTests.setUp
    tearDown = support.HTTPTests.tearDown
    request = support.HTTPTests.request
    enable_outline = support.HTTPTests.enable_outline
    setup_provider = support.HTTPTests.setup_provider

    def ready(self):
        self.enable_outline()
        return self.server.store.get(self.pid)

    def payload(self, p, original="信封是干的。", chapter_index=0):
        return {"revision": p["revision"], **selection(p["chapters"][chapter_index], original),
                "instructions": "只改信封的湿度，保留其他细节。"}

    def preview(self, body):
        _, raw = self.request(f"/api/projects/{self.pid}/edit-preview", body)
        return json.loads(raw)["edit"]

    def apply(self, p, edit):
        _, raw = self.request(f"/api/projects/{self.pid}/mutate", {
            "revision": p["revision"], "action": "apply_local_edit", "data": edit})
        return json.loads(raw)["project"]

    def test_preview_sends_selected_text_and_author_request_without_saving(self):
        p = self.ready()
        body = self.payload(p)
        body["previous_replacement"] = "信封微微湿润。"
        with patch("app.call_model", return_value={"replacement": "信封有一点湿。"}) as model:
            edit = self.preview(body)
        self.assertEqual(self.server.store.get(self.pid), p)
        args, kwargs = model.call_args
        self.assertEqual(args[3], "edit")
        context = args[2]
        self.assertEqual(context["local_edit"]["selection"]["original"], body["selected_text"])
        self.assertEqual(context["local_edit"]["previous_replacement"], body["previous_replacement"])
        self.assertEqual(kwargs["instructions"], body["instructions"])
        self.assertIn("whole_book_direction", context)
        self.assertEqual(edit["source_revision"], p["revision"])
        self.assertEqual(edit["replacement"], "信封有一点湿。")

    def test_model_adapter_round_trip_and_truncation_errors_leave_source_untouched(self):
        self.setup_provider()
        p = self.ready()
        captured = []

        def provider_reply(handler):
            sent = json.loads(handler.rfile.read(int(handler.headers["Content-Length"])))
            captured.append(sent)
            body = {"choices": [{"finish_reason": "stop", "message": {
                "content": json.dumps({"replacement": "信封有一点湿。"}, ensure_ascii=False)}}]}
            raw = json.dumps(body).encode("utf-8")
            handler.send_response(200)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(raw)))
            handler.end_headers()
            handler.wfile.write(raw)

        with patch.object(support.ProviderHandler, "do_POST", provider_reply):
            edit = self.preview(self.payload(p))
        self.assertEqual(edit["replacement"], "信封有一点湿。")
        self.assertEqual(captured[0]["model"], "test-model")
        sent = json.loads(captured[0]["messages"][1]["content"])
        self.assertIn("replacement", sent["task"])
        self.assertEqual(sent["context"]["local_edit"]["selection"]["original"], "信封是干的。")
        self.assertEqual(sent["author_instructions"], self.payload(p)["instructions"])
        self.assertEqual(self.server.store.get(self.pid), p)
        for mode in ("bad", "length"):
            support.ProviderHandler.mode = mode
            with self.subTest(mode=mode), self.assertRaises(HTTPError) as caught:
                self.preview(self.payload(p))
            self.assertEqual(caught.exception.code, 400)
            self.assertEqual(self.server.store.get(self.pid), p)

    def test_adoption_accepts_manual_preview_edit_without_calling_model_again(self):
        p = self.ready()
        with patch("app.call_model", return_value={"replacement": "信封有一点湿。"}):
            edit = self.preview(self.payload(p))
        edit["replacement"] = "信封的一角被雨水浸透。"
        with patch("app.call_model") as model:
            saved = self.apply(p, edit)
        model.assert_not_called()
        original = p["chapters"][0]["text"]
        self.assertEqual(saved["chapters"][0]["text"], original.replace("信封是干的。", edit["replacement"], 1))
        self.assertEqual(saved["revision"], p["revision"] + 1)
        self.assertTrue(saved["chapters"][0]["local_edit_review_required"])

    def test_invalid_requirements_or_prior_replacement_rejected_before_model(self):
        p = self.ready()
        body = self.payload(p)
        cases = [{**body, "instructions": value} for value in ("", " \n\t", None, 1, "长" * 5001)]
        cases += [{**body, "previous_replacement": value} for value in (None, [], "长" * 30001)]
        cases += [{**body, "selected_text": "与正文不一致"}]
        with patch("app.call_model") as model:
            for data in cases:
                with self.subTest(keys=list(data)), self.assertRaises(HTTPError) as caught:
                    self.preview(data)
                self.assertEqual(caught.exception.code, 400)
                self.assertEqual(self.server.store.get(self.pid), p)
        model.assert_not_called()

    def test_missing_outline_and_unbound_node_still_block_revision_preview(self):
        p = self.server.store.get(self.pid)
        with patch("app.call_model") as model:
            with self.assertRaises(HTTPError) as caught:
                self.preview(self.payload(p))
            self.assertEqual(caught.exception.code, 400)
            p = self.ready()
            p = self.server.store.update(self.pid, p["revision"], lambda current: current["chapters"][0].update(node_id=""))
            with self.assertRaises(HTTPError) as caught:
                self.preview(self.payload(p))
            self.assertEqual(caught.exception.code, 400)

        model.assert_not_called()
        self.assertEqual(self.server.store.get(self.pid), p)

    def test_existing_prose_revision_can_precede_prior_reapproval_but_new_draft_and_canon_cannot(self):
        p = self.ready()
        def prior_not_ready(current):
            current["chapters"][0].update(status="needs_review")
            current["chapters"][1].update(text="林照站在门外。", summary="林照等待。")
            future = novel.chapter("未来章节")
            future.update(text="FUTURE-PROSE-MUST-NOT-LEAK", summary="未来秘密")
            current["chapters"].append(future)
        p = self.server.store.update(self.pid, p["revision"], prior_not_ready)
        with patch("app.call_model", return_value={"replacement": "林照停在门外。"}) as model:
            edit = self.preview(self.payload(p, "林照站在门外。", chapter_index=1))
        self.assertEqual(self.server.store.get(self.pid), p)
        self.assertTrue(edit["warnings"])
        context = model.call_args.args[2]
        self.assertEqual(context["revision_context"]["unconfirmed_previous_chapters"][0]["id"], p["chapters"][0]["id"])
        self.assertFalse(context["previous_chapters"])
        self.assertFalse(context["recent_prose"])
        self.assertNotIn("FUTURE-PROSE-MUST-NOT-LEAK", json.dumps(context))
        with patch("app.call_model") as model:
            with self.assertRaises(HTTPError) as caught:
                self.request(f"/api/projects/{self.pid}/ai", {"revision": p["revision"], "chapter_id": p["chapters"][1]["id"], "action": "draft"})
            self.assertEqual(caught.exception.code, 400)
        model.assert_not_called()
        saved = self.apply(p, edit)
        self.assertEqual(saved["chapters"][1]["text"], "林照停在门外。")
        self.assertNotEqual(saved["chapters"][1]["status"], "approved")
        with self.assertRaises(HTTPError) as caught:
            self.request(f"/api/projects/{self.pid}/mutate", {"revision": saved["revision"], "action": "approve",
                "data": {"id": saved["chapters"][1]["id"], "outline_checked": True, "local_edit_checked": True}})
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(self.server.store.get(self.pid), saved)

    def test_provider_failure_or_malformed_result_preserves_everything(self):
        p = self.ready()
        cases = [novel.StoryError("模型调用失败"), {}, {"text": "整章改写"},
                 {"replacement": None}, {"replacement": "长" * 30001}]
        for result in cases:
            options = {"side_effect": result} if isinstance(result, Exception) else {"return_value": result}
            with self.subTest(result_type=type(result).__name__), patch("app.call_model", **options):
                with self.assertRaises(HTTPError) as caught:
                    self.preview(self.payload(p))
                self.assertEqual(caught.exception.code, 400)
                self.assertEqual(self.server.store.get(self.pid), p)

    def test_stale_request_and_concurrent_change_reject_preview_without_overwriting(self):
        p = self.ready()
        body = self.payload(p)
        with patch("app.call_model") as model:
            with self.assertRaises(HTTPError) as caught:
                self.preview({**body, "revision": p["revision"] - 1})
            self.assertEqual(caught.exception.code, 409)
        model.assert_not_called()

        def competing_call(*args, **kwargs):
            self.server.store.update(self.pid, p["revision"], lambda current: current.update(title="另一窗口的标题"))
            return {"replacement": "信封有一点湿。"}
        with patch("app.call_model", side_effect=competing_call):
            with self.assertRaises(HTTPError) as caught:
                self.preview(body)
        self.assertEqual(caught.exception.code, 409)
        saved = self.server.store.get(self.pid)
        self.assertEqual(saved["title"], "另一窗口的标题")
        self.assertEqual(saved["chapters"], p["chapters"])

    def test_adoption_checks_both_outer_and_source_revisions(self):
        p = self.ready()
        with patch("app.call_model", return_value={"replacement": "信封有一点湿。"}):
            edit = self.preview(self.payload(p))
        latest = self.server.store.update(self.pid, p["revision"], lambda current: current.update(title="更新作品"))
        with self.assertRaises(HTTPError) as caught:
            self.apply(p, edit)
        self.assertEqual(caught.exception.code, 409)
        with self.assertRaises(HTTPError) as caught:
            self.apply(latest, edit)
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(self.server.store.get(self.pid), latest)

    def test_empty_preview_can_be_adopted_as_deletion(self):
        p = self.ready()
        with patch("app.call_model", return_value={"replacement": ""}):
            edit = self.preview(self.payload(p))
        saved = self.apply(p, edit)
        self.assertEqual(saved["chapters"][0]["text"], p["chapters"][0]["text"].replace("信封是干的。", "", 1))

    def test_confirmation_gate_is_enforced_through_http(self):
        p = self.ready()
        with patch("app.call_model", return_value={"replacement": "信封仍然干燥。"}):
            edit = self.preview(self.payload(p))
        p = self.apply(p, edit)
        data = {"id": p["chapters"][0]["id"], "outline_checked": True}
        with self.assertRaises(HTTPError) as caught:
            self.request(f"/api/projects/{self.pid}/mutate", {"revision": p["revision"], "action": "approve", "data": data})
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(self.server.store.get(self.pid), p)
        _, raw = self.request(f"/api/projects/{self.pid}/mutate", {
            "revision": p["revision"], "action": "approve", "data": {**data, "local_edit_checked": True}})
        saved = json.loads(raw)["project"]
        self.assertEqual(saved["chapters"][0]["status"], "approved")
        self.assertFalse(saved["chapters"][0]["local_edit_review_required"])


if __name__ == "__main__":
    unittest.main()
