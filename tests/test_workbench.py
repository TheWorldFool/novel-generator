import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import app
import novel
import outline as story_outline


class DomainTests(unittest.TestCase):
    def setUp(self):
        self.p = novel.demo_project()
        self.first, self.second = self.p["chapters"]
        self.hero = self.p["entities"][0]

    def prepared_second(self):
        self.second.update(text="林照走进港务所，把信交给沈砚。", summary="林照到达港务所并交出信件。", changes=[
            {"id": "test-change", "entity_id": self.hero["id"], "field": "location", "value": "港务所", "evidence": "林照走进港务所", "selected": True}
        ])

    def test_draft_never_changes_canon(self):
        self.prepared_second()
        hero = next(e for e in novel.canon(self.p) if e["id"] == self.hero["id"])
        self.assertEqual(hero["state"]["location"], "旧船厂")
        novel.approve(self.p, self.second["id"])
        hero = next(e for e in novel.canon(self.p) if e["id"] == self.hero["id"])
        self.assertEqual(hero["state"]["location"], "港务所")
        self.assertEqual(hero["sources"]["location"]["evidence"], "林照走进港务所")

    def test_review_candidates_require_explicit_selection(self):
        novel.apply_ai(self.p, self.second["id"], "draft", {"text": "林照走进港务所。", "summary": "林照抵达。", "changes": [{"entity_id": self.hero["id"], "field": "location", "value": "港务所", "evidence": "林照走进港务所。", "selected": True}]})
        self.assertFalse(self.second["changes"][0]["selected"])
        novel.approve(self.p, self.second["id"])
        self.assertEqual(self.second["accepted_changes"], [])

    def test_invalid_evidence_and_locked_entity_rejected(self):
        self.prepared_second()
        self.second["changes"][0]["evidence"] = "没有发生的事"
        with self.assertRaisesRegex(novel.StoryError, "原文依据"):
            novel.approve(self.p, self.second["id"])
        self.second["changes"][0]["evidence"] = "林照走进港务所"
        self.hero["locked"] = True
        with self.assertRaisesRegex(novel.StoryError, "已锁定"):
            novel.approve(self.p, self.second["id"])

    def test_duplicate_field_and_unknown_field_rejected(self):
        self.prepared_second()
        self.second["changes"].append(copy.deepcopy(self.second["changes"][0]))
        with self.assertRaisesRegex(novel.StoryError, "最终值"):
            novel.approve(self.p, self.second["id"])
        self.second["changes"] = self.second["changes"][:1]
        self.second["changes"][0]["field"] = "not-a-field"
        with self.assertRaisesRegex(novel.StoryError, "不存在"):
            novel.approve(self.p, self.second["id"])

    def test_editing_earlier_chapter_invalidates_later_canon(self):
        self.prepared_second()
        novel.approve(self.p, self.second["id"])
        novel.mutate(self.p, "save_chapter", {"id": self.first["id"], "text": self.first["text"] + "\n窗外又起了雾。"})
        self.assertEqual([c["status"] for c in self.p["chapters"]], ["needs_review", "needs_review"])
        hero = next(e for e in novel.canon(self.p) if e["id"] == self.hero["id"])
        self.assertEqual(hero["state"]["location"], self.hero["base"]["location"])
        with self.assertRaisesRegex(novel.StoryError, "顺序"):
            novel.approve(self.p, self.second["id"])
        novel.approve(self.p, self.first["id"])
        self.assertEqual(self.second["status"], "needs_review")
        novel.approve(self.p, self.second["id"])
        self.assertEqual(self.second["status"], "approved")

    def test_context_excludes_future_and_current_chapter_states(self):
        self.prepared_second()
        novel.approve(self.p, self.second["id"])
        context = novel.build_context(self.p, self.first)
        self.assertFalse(context["previous_chapters"])
        hero = next(e for e in context["entities"] if e["id"] == self.hero["id"])
        self.assertEqual(hero["state"]["inventory"], "父亲留下的黄铜罗盘")
        context2 = novel.build_context(self.p, self.second)
        self.assertEqual(len(context2["previous_chapters"]), 1)
        hero2 = next(e for e in context2["entities"] if e["id"] == self.hero["id"])
        self.assertEqual(hero2["state"]["location"], "旧船厂")

    def test_restore_keeps_current_version_and_clears_stale_candidates(self):
        old = self.first["versions"][0]
        original_id = old["id"]
        novel.mutate(self.p, "save_chapter", {"id": self.first["id"], "text": "修改后的文字。"})
        novel.mutate(self.p, "restore", {"id": self.first["id"], "version_id": original_id})
        self.assertEqual(self.first["text"], old["text"])
        self.assertEqual(self.first["changes"], [])
        self.assertEqual(self.first["status"], "needs_review")
        self.assertTrue(any(v["text"] == "修改后的文字。" for v in self.first["versions"]))

    def test_editing_baseline_invalidates_approved_but_lock_toggle_does_not(self):
        data = copy.deepcopy(self.hero)
        data["locked"] = True
        novel.mutate(self.p, "save_entity", data)
        self.assertEqual(self.first["status"], "approved")
        data["base"]["location"] = "新船厂"
        novel.mutate(self.p, "save_entity", data)
        self.assertEqual(self.first["status"], "needs_review")

    def test_empty_draft_or_summary_cannot_be_approved(self):
        with self.assertRaisesRegex(novel.StoryError, "正文"):
            novel.approve(self.p, self.second["id"])
        self.second["text"] = "正文"
        with self.assertRaisesRegex(novel.StoryError, "摘要"):
            novel.approve(self.p, self.second["id"])

    def test_plan_review_rewrite_keep_approval_explicit(self):
        self.prepared_second()
        novel.apply_ai(self.p, self.second["id"], "plan", {"outline": "试探沈砚，发现线索。"})
        novel.apply_ai(self.p, self.second["id"], "review", {"overview": "可加强行动动机。", "issues": [{"severity": "建议", "kind": "人物", "quote": "把信交给沈砚", "message": "为什么突然交信？", "suggestion": "加入试探的目的。"}]})
        self.assertEqual(self.second["review"]["source"], "ai")
        self.assertEqual(self.second["status"], "draft")
        novel.approve(self.p, self.second["id"])
        novel.apply_ai(self.p, self.second["id"], "rewrite", {"text": "林照把信递过去，紧盯着沈砚的手。", "summary": "林照交信试探沈砚。", "changes": []})
        self.assertEqual(self.second["status"], "needs_review")
        self.assertIsNone(self.second["review"])
        self.assertTrue(any(v["text"] == "林照走进港务所，把信交给沈砚。" for v in self.second["versions"]))


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = app.Store(Path(self.tmp.name) / "test.sqlite3")
        self.pid = self.store.list()[0]["id"]

    def tearDown(self):
        self.tmp.cleanup()

    def test_conflict_does_not_overwrite(self):
        self.store.update(self.pid, 0, lambda p: p.update(title="新版"))
        with self.assertRaises(app.Conflict):
            self.store.update(self.pid, 0, lambda p: p.update(title="过期版本"))
        self.assertEqual(self.store.get(self.pid)["title"], "新版")

    def test_failed_mutation_rolls_back_everything(self):
        def bad(p):
            p["title"] = "不应保存"
            raise novel.StoryError("失败")
        before = self.store.get(self.pid)
        with self.assertRaises(novel.StoryError):
            self.store.update(self.pid, 0, bad)
        self.assertEqual(self.store.get(self.pid), before)

    def test_reopening_database_preserves_work(self):
        self.store.update(self.pid, 0, lambda p: p.update(title="持久作品"))
        reopened = app.Store(self.store.path)
        self.assertEqual(reopened.get(self.pid)["title"], "持久作品")
        self.assertEqual(len(reopened.list()), 1)

    def test_invalid_word_target_rolls_back_story_edits(self):
        with self.assertRaises(novel.StoryError):
            self.store.update(self.pid, 0, lambda p: novel.mutate(p, "save_story", {"title": "不能提交", "brief": {"target": "-10"}}))
        self.assertEqual(self.store.get(self.pid)["title"], "雾港来信")


class ProviderHandler(BaseHTTPRequestHandler):
    mode = "ok"
    requests = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).requests.append(data)
        user_content = data["messages"][1]["content"]
        context = json.loads(user_content[0]["text"] if isinstance(user_content, list) else user_content)["context"]
        if "outline_draft" in context:
            source = context["outline_draft"]["text"]
            content = {"ending": context["outline_draft"]["ending"] or "公开证据，重开雾港。", "nodes": [
                {"title": "收到信件", "goal": "开始调查来信", "must": "收到来信", "avoid": "不能提前揭开真相", "source_quote": source[:8]},
                {"title": "揭开旧案", "goal": "公开证据", "must": "作出公开的选择", "avoid": "不能改变结局", "source_quote": source[-8:]}
            ]}
        elif context.get("reference_kind") == "style":
            content = {"overview": "短句与留白。", "style": {key: "采用具体动作，保留信息差。" for key in novel.STYLE_FIELDS},
                       "evidence": [{"quote": context["reference"]["text"][:10], "observation": "由动作表现情绪。"}]}
        elif context.get("reference_kind") == "character":
            content = {"observations": {"appearance": "短发", "clothing": "蓝色外套", "posture": "站立", "expression": "嘴角平直"}, "uncertainties": ["无法从图片确定经历"],
                       "character": {"name": "新角色", "description": "虚构建议：害怕失去同伴的修船匠。", "base": {"goal": "寻找失散的朋友"}}}
        else:
            hero = next(e for e in context["entities"] if e["kind"] == "character")
            content = {"text": "林照走进港务所。", "summary": "林照抵达港务所。", "changes": [{"entity_id": hero["id"], "field": "location", "value": "港务所", "evidence": "林照走进港务所。"}]}
        body = {"choices": [{"finish_reason": "length" if self.mode == "length" else "stop", "message": {"content": "invalid" if self.mode == "bad" else json.dumps(content, ensure_ascii=False)}}]}
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.server = app.AppServer(("127.0.0.1", 0), app.Store(Path(self.tmp.name) / "test.sqlite3"))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.pid = self.server.store.list()[0]["id"]
        self.provider = ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
        self.provider_thread = threading.Thread(target=self.provider.serve_forever, daemon=True)
        self.provider_thread.start()
        ProviderHandler.mode = "ok"
        ProviderHandler.requests = []

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.provider.shutdown()
        self.provider.server_close()
        self.thread.join()
        self.provider_thread.join()
        self.tmp.cleanup()

    def request(self, path, body=None, headers=None):
        h = {"Content-Type": "application/json"}
        h.update(headers or {})
        req = Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, headers=h)
        with urlopen(req) as response:
            return response.status, response.read()

    def setup_provider(self):
        self.request("/api/settings", {"base_url": f"http://127.0.0.1:{self.provider.server_port}/v1", "model": "test-model", "api_key": "test-secret-never-on-disk", "max_tokens": 6000})

    def enable_outline(self):
        p = self.server.store.get(self.pid)
        def fixture(current):
            book = story_outline.ensure(current)
            book["active"] = {"text": "林照收到来信后到港务所调查，最后公开证据。", "ending": "公开证据", "guardrails": "不能提前揭开来信机制", "nodes": [
                {"id": "investigate", "title": "调查", "goal": "找到线索", "must": "林照前往港务所", "avoid": "不能提前公开证据", "source_quote": "林照收到来信后到港务所调查"}
            ]}
            book["draft"] = copy.deepcopy(book["active"])
            book["version"] = 1
            for chapter in current["chapters"]:
                chapter["node_id"] = "investigate"
        self.server.store.update(self.pid, p["revision"], fixture)

    def test_key_is_not_returned_or_written_to_database(self):
        self.setup_provider()
        _, raw = self.request("/api/settings")
        self.assertTrue(json.loads(raw)["has_key"])
        self.assertNotIn(b"test-secret", raw)
        for file in Path(self.tmp.name).iterdir():
            self.assertNotIn(b"test-secret", file.read_bytes())

    def test_cross_site_requests_and_dns_rebinding_blocked(self):
        for headers in ({"Origin": "https://attacker.example"}, {"Host": "attacker.example"}):
            with self.assertRaises(HTTPError) as cm:
                self.request("/api/projects", {"title": "bad"}, headers)
            self.assertEqual(cm.exception.code, 403)

    def test_complete_generation_approval_and_export(self):
        self.setup_provider()
        self.enable_outline()
        p = self.server.store.get(self.pid)
        cid = p["chapters"][1]["id"]
        _, raw = self.request(f"/api/projects/{self.pid}/ai", {"revision": p["revision"], "chapter_id": cid, "action": "draft"})
        p = json.loads(raw)["project"]
        c = p["chapters"][1]
        self.assertEqual(c["text"], "林照走进港务所。")
        self.assertFalse(c["changes"][0]["selected"])
        c["changes"][0]["selected"] = True
        _, raw = self.request(f"/api/projects/{self.pid}/mutate", {"revision": p["revision"], "action": "save_chapter", "data": {"id": cid, "changes": c["changes"]}})
        p = json.loads(raw)["project"]
        _, raw = self.request(f"/api/projects/{self.pid}/mutate", {"revision": p["revision"], "action": "approve", "data": {"id": cid, "outline_checked": True}})
        result = json.loads(raw)
        hero = next(e for e in result["canon"] if e["name"] == "林照")
        self.assertEqual(hero["state"]["location"], "港务所")
        _, export = self.request(f"/api/projects/{self.pid}/export")
        self.assertIn("林照走进港务所。", export.decode())
        self.assertIn("已确认", export.decode())
        self.assertEqual(len(ProviderHandler.requests), 1)

    def test_model_errors_do_not_replace_draft(self):
        self.setup_provider()
        self.enable_outline()
        p = self.server.store.get(self.pid)
        for mode in ("bad", "length"):
            ProviderHandler.mode = mode
            with self.assertRaises(HTTPError) as cm:
                self.request(f"/api/projects/{self.pid}/ai", {"revision": p["revision"], "chapter_id": p["chapters"][1]["id"], "action": "draft"})
            self.assertEqual(cm.exception.code, 400)
            self.assertEqual(self.server.store.get(self.pid), p)

    def test_static_assets_and_missing_settings(self):
        for path in ("/", "/app.js", "/style.css", "/favicon.svg", "/outline.js", "/outline.css"):
            code, body = self.request(path)
            self.assertEqual(code, 200)
            self.assertTrue(body)
        self.enable_outline()
        p = self.server.store.get(self.pid)
        with self.assertRaises(HTTPError) as cm:
            self.request(f"/api/projects/{self.pid}/ai", {"revision": p["revision"], "chapter_id": p["chapters"][1]["id"], "action": "draft"})
        self.assertEqual(cm.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
