import copy
import json
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

import novel
import test_workbench as support


class MemoryHTTPTests(unittest.TestCase):
    setUp = support.HTTPTests.setUp
    tearDown = support.HTTPTests.tearDown
    request = support.HTTPTests.request
    setup_provider = support.HTTPTests.setup_provider

    def payload(self, p, **extra):
        return {"revision": p["revision"], "chapter_id": p["chapters"][0]["id"], **extra}

    def preview(self, p, **extra):
        _, raw = self.request(f"/api/projects/{self.pid}/memory-preview", self.payload(p, **extra))
        return json.loads(raw)["memory"]

    def adopt(self, p, candidate):
        _, raw = self.request(f"/api/projects/{self.pid}/mutate", {"revision": p["revision"], "action": "apply_memory", "data": candidate})
        return json.loads(raw)

    def model_result(self, p):
        return {"summary": "林照收起父亲的来信，随后前往港务所调查。", "text": "这个额外字段不能改变正文",
                "changes": [{**p["chapters"][0]["changes"][0], "selected": True}]}

    def test_manual_editor_is_available_without_model_and_does_not_write(self):
        p = self.server.store.get(self.pid)
        with patch("app.call_model") as model:
            candidate = self.preview(p, manual=True)
        model.assert_not_called()
        self.assertTrue(candidate["manual"])
        self.assertEqual(candidate["summary"], p["chapters"][0]["summary"])
        self.assertEqual(candidate["changes"], p["chapters"][0]["changes"])
        self.assertEqual(self.server.store.get(self.pid), p)

    def test_real_adapter_extracts_only_current_prose_and_explicit_adoption_preserves_it(self):
        self.setup_provider()
        p = self.server.store.get(self.pid)
        captures = []
        result = self.model_result(p)
        def provider_reply(handler):
            sent = json.loads(handler.rfile.read(int(handler.headers["Content-Length"])))
            captures.append(json.loads(sent["messages"][1]["content"]))
            raw = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(result, ensure_ascii=False)}}]}).encode()
            handler.send_response(200)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(raw)))
            handler.end_headers()
            handler.wfile.write(raw)
        with patch.object(support.ProviderHandler, "do_POST", provider_reply):
            candidate = self.preview(p, instructions="重点记录物品与行动")
        self.assertEqual(captures[0]["context"]["chapter"]["text"], p["chapters"][0]["text"])
        self.assertEqual(captures[0]["author_instructions"], "重点记录物品与行动")
        self.assertNotIn("whole_book_direction", captures[0]["context"])
        self.assertNotIn(p["chapters"][1]["intent"], json.dumps(captures[0]["context"], ensure_ascii=False))
        self.assertFalse(candidate["changes"][0]["selected"])
        self.assertEqual(self.server.store.get(self.pid), p)
        candidate["changes"][0]["selected"] = True
        candidate["summary"] += "作者核对后补充。"
        saved = self.adopt(p, {**candidate, "text": "不能覆盖正文"})["project"]
        c = saved["chapters"][0]
        for key in ("text", "outline", "intent", "cast", "node_id", "completes_node", "node_evidence", "accepted_text", "accepted_summary", "accepted_changes"):
            self.assertEqual(c[key], p["chapters"][0][key], key)
        self.assertEqual(c["summary"], candidate["summary"])
        self.assertEqual(c["status"], "needs_review")
        self.assertTrue(c["local_edit_review_required"])
        self.assertEqual(c["versions"][-1]["summary"], p["chapters"][0]["summary"])
        with self.assertRaises(HTTPError):
            self.request(f"/api/projects/{self.pid}/mutate", {"revision": saved["revision"], "action": "approve", "data": {"id": c["id"]}})
        _, raw = self.request(f"/api/projects/{self.pid}/mutate", {"revision": saved["revision"], "action": "approve", "data": {"id": c["id"], "local_edit_checked": True}})
        self.assertEqual(json.loads(raw)["project"]["chapters"][0]["status"], "approved")

    def test_invalid_candidates_are_reported_and_cannot_be_adopted_by_forging_selection(self):
        p = self.server.store.get(self.pid)
        result = self.model_result(p)
        result["changes"] += [{"entity_id": "missing", "field": "goal", "value": "不存在的目标", "evidence": "伪造依据"}]
        with patch("app.call_model", return_value=result):
            candidate = self.preview(p)
        self.assertEqual(len(candidate["changes"]), 1)
        self.assertTrue(candidate["warnings"])
        candidate["changes"][0].update(selected=True, evidence="正文没有这句话")
        with self.assertRaises(HTTPError) as caught:
            self.adopt(p, candidate)
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(self.server.store.get(self.pid), p)

    def test_stale_or_malformed_input_is_rejected_before_model(self):
        p = self.server.store.get(self.pid)
        with patch("app.call_model") as model:
            for extra in ({"revision": -1}, {"revision": False}, {"manual": "true"}, {"instructions": None}, {"instructions": "文" * 5001}):
                with self.subTest(extra=extra), self.assertRaises(HTTPError):
                    self.preview(p, **extra)
        model.assert_not_called()
        self.assertEqual(self.server.store.get(self.pid), p)

    def test_concurrent_work_and_old_preview_never_overwrite_new_memory(self):
        p = self.server.store.get(self.pid)
        candidate = self.preview(p, manual=True)
        latest = self.server.store.update(self.pid, p["revision"], lambda p: p["chapters"][0].update(summary="另一窗口已整理的摘要"))
        with self.assertRaises(HTTPError):
            self.adopt(latest, candidate)
        self.assertEqual(self.server.store.get(self.pid), latest)
        def competing(*args, **kwargs):
            self.server.store.update(self.pid, latest["revision"], lambda p: p.update(title="生成期间更新的作品"))
            return self.model_result(latest)
        with patch("app.call_model", side_effect=competing), self.assertRaises(HTTPError) as caught:
            self.preview(latest)
        self.assertEqual(caught.exception.code, 409)
        final = self.server.store.get(self.pid)
        self.assertEqual(final["chapters"], latest["chapters"])
        self.assertEqual(final["title"], "生成期间更新的作品")

    def test_blank_body_and_model_failures_leave_old_memory_intact(self):
        p = self.server.store.get(self.pid)
        for result in ({}, {"summary": "", "changes": []}, {"summary": "摘要", "changes": None}, novel.StoryError("模型失败")):
            options = {"side_effect": result} if isinstance(result, Exception) else {"return_value": result}
            with self.subTest(result=type(result).__name__), patch("app.call_model", **options), self.assertRaises(HTTPError):
                self.preview(p)
            self.assertEqual(self.server.store.get(self.pid), p)
        p = self.server.store.update(self.pid, p["revision"], lambda p: p["chapters"][0].update(text=" \n"))
        with patch("app.call_model") as model, self.assertRaises(HTTPError):
            self.preview(p)
        model.assert_not_called()
        self.assertEqual(self.server.store.get(self.pid), p)


if __name__ == "__main__":
    unittest.main()
