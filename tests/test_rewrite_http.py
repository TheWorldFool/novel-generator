"""The full-chapter model request is read-only until an author adopts its result."""
import copy
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import app
import novel
import test_workbench as support


class RewriteHTTPTests(unittest.TestCase):
    setUp = support.HTTPTests.setUp
    tearDown = support.HTTPTests.tearDown
    request = support.HTTPTests.request
    enable_outline = support.HTTPTests.enable_outline
    setup_provider = support.HTTPTests.setup_provider

    def ready(self):
        self.enable_outline()
        p = self.server.store.get(self.pid)
        def write(current):
            current["chapters"][1].update(text="林照还站在港务所门外。", summary="林照停在门外。")
        return self.server.store.update(self.pid, p["revision"], write)

    def preview(self, p):
        _, raw = self.request(f"/api/projects/{self.pid}/ai", {"revision": p["revision"],
            "chapter_id": p["chapters"][1]["id"], "action": "rewrite", "instructions": "把动作写得更克制。"})
        return json.loads(raw)["proposal"]

    def adopt(self, p, proposal, **changes):
        _, raw = self.request(f"/api/projects/{self.pid}/mutate", {"revision": p["revision"],
            "action": "apply_rewrite_proposal", "data": {**proposal, **changes}})
        return json.loads(raw)["project"]

    def test_real_adapter_preview_does_not_write_and_adoption_preserves_the_original(self):
        self.setup_provider()
        before = self.ready()
        proposal = self.preview(before)
        self.assertEqual(proposal["kind"], "rewrite")
        self.assertEqual(self.server.store.get(self.pid), before)
        self.assertEqual(proposal["original"]["text"], before["chapters"][1]["text"])
        self.assertTrue(all(not c["selected"] for c in proposal["changes"]))
        after = self.adopt(before, proposal, text="林照收住脚步，停在港务所门外。", summary="林照停在门外，没有进屋。", changes=[])
        chapter = after["chapters"][1]
        self.assertEqual(chapter["text"], "林照收住脚步，停在港务所门外。")
        self.assertEqual(chapter["accepted_text"], before["chapters"][1]["accepted_text"])
        self.assertNotEqual(chapter["status"], "approved")
        self.assertTrue(any(v["text"] == before["chapters"][1]["text"] for v in chapter["versions"]))
        self.assertEqual(after["chapters"][0], before["chapters"][0])
        self.assertEqual(len(support.ProviderHandler.requests), 1)

    def test_stale_preview_and_model_concurrency_do_not_overwrite_new_writing(self):
        before = self.ready()
        result = {"text": "林照走进港务所。", "summary": "林照进屋。", "changes": []}
        with patch("app.call_model", return_value=result):
            proposal = self.preview(before)
        current = self.server.store.update(self.pid, before["revision"], lambda p: p["chapters"][1].update(text="作者刚补写的新正文。"))
        with self.assertRaises(HTTPError):
            self.adopt(current, proposal)
        self.assertEqual(self.server.store.get(self.pid), current)
        def concurrent(*args, **kwargs):
            self.server.store.update(self.pid, current["revision"], lambda p: p.update(title="模型等待期间改名"))
            return result
        with patch("app.call_model", side_effect=concurrent), self.assertRaises(HTTPError) as caught:
            self.preview(current)
        self.assertEqual(caught.exception.code, 409)
        self.assertEqual(self.server.store.get(self.pid)["chapters"][1]["text"], "作者刚补写的新正文。")

    def test_bad_model_results_and_invalid_adoptions_leave_all_history_untouched(self):
        before = self.ready()
        for result in (None, {}, {"text": "", "summary": "摘要", "changes": []},
                       {"text": "新正文。", "summary": "新摘要。", "changes": "wrong"}):
            with self.subTest(result=result), patch("app.call_model", return_value=result), self.assertRaises(HTTPError):
                self.preview(before)
            self.assertEqual(self.server.store.get(self.pid), before)
        result = {"text": "林照走进港务所。", "summary": "林照进屋。", "changes": []}
        with patch("app.call_model", return_value=result):
            proposal = self.preview(before)
        for values in ({"source_hash": "x" * 64}, {"source_revision": True}, {"text": " "}, {"summary": ""},
                       {"changes": [{"id": "forged", "entity_id": before["entities"][0]["id"], "field": "location",
                                     "value": "港务所", "evidence": "不存在的依据", "selected": True}]}):
            with self.subTest(values=values), self.assertRaises(HTTPError):
                self.adopt(before, proposal, **values)
            self.assertEqual(self.server.store.get(self.pid), before)

    def test_full_rewrite_keeps_ordered_generation_gate(self):
        before = self.ready()
        current = self.server.store.update(self.pid, before["revision"], lambda p: p["chapters"][0].update(status="needs_review"))
        with patch("app.call_model") as model, self.assertRaises(HTTPError):
            self.preview(current)
        model.assert_not_called()
        self.assertEqual(self.server.store.get(self.pid), current)


if __name__ == "__main__":
    unittest.main()
