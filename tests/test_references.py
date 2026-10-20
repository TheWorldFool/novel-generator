import base64
import copy
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import app
import novel
import test_workbench as support

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/a6XcAAAAASUVORK5CYII="


def style_result():
    return {"overview": "克制的动作叙述。", "style": {k: f"{k}的候选规则" for k in novel.STYLE_FIELDS},
            "evidence": [{"quote": "他放下杯子。", "observation": "以动作表现情绪"}, {"quote": "不存在的引文", "observation": "错误引用"}]}


def character_result():
    return {"observations": {"appearance": "短发", "clothing": "蓝色外套", "posture": "站立", "expression": "嘴角平直"},
            "uncertainties": ["图片无法显示人物的经历"], "character": {"name": "候选角色", "description": "虚构建议：一名胆怯的信使。",
            "base": {"appearance": "不应采用的无依据特征", "goal": "找到失踪的朋友", "knowledge": "知道一条秘密航线"}}}


class ReferenceDomainTests(unittest.TestCase):
    def setUp(self):
        self.p = novel.upgrade(novel.demo_project())

    def add_style(self, text="他放下杯子。窗外的雨还没停。"):
        novel.mutate(self.p, "save_style_reference", {"title": "参考文段", "text": text, "notes": "学习句式"})
        return self.p["references"][-1]

    def add_character(self):
        ref, _ = app.prepare_image({"title": "人物图", "base64": PNG, "entity_id": self.p["entities"][0]["id"]})
        novel.add_image_reference(self.p, ref)
        novel.save_reference_analysis(self.p, ref["id"], character_result())
        return ref

    def test_analysis_is_proposal_and_checks_evidence(self):
        ref = self.add_style()
        before = copy.deepcopy(self.p["style"])
        novel.save_reference_analysis(self.p, ref["id"], style_result())
        self.assertEqual(self.p["style"], before)
        self.assertFalse(ref["active"])
        self.assertTrue(ref["analysis"]["evidence"][0]["verified"])
        self.assertFalse(ref["analysis"]["evidence"][1]["verified"])

    def test_apply_style_changes_only_selected_dimensions(self):
        ref = self.add_style()
        novel.save_reference_analysis(self.p, ref["id"], style_result())
        before = copy.deepcopy(self.p["style"])
        novel.mutate(self.p, "apply_style_analysis", {"id": ref["id"], "fields": ["rhythm"], "values": {"rhythm": "短句推动冲突。", "dialogue": "不应采用"}})
        self.assertEqual(self.p["style"]["rhythm"], "短句推动冲突。")
        self.assertEqual(self.p["style"]["dialogue"], before["dialogue"])
        self.assertEqual(self.p["chapters"][0]["status"], "approved")

    def test_editing_source_invalidates_old_analysis_and_disables_sample(self):
        ref = self.add_style()
        novel.save_reference_analysis(self.p, ref["id"], style_result())
        novel.mutate(self.p, "toggle_style_reference", {"id": ref["id"], "active": True})
        novel.mutate(self.p, "save_style_reference", {"id": ref["id"], "title": "修改后", "text": "新文本", "notes": "新重点"})
        self.assertIsNone(ref["analysis"])
        self.assertFalse(ref["active"])

    def test_style_context_respects_mode_selection_and_bounded_excerpt(self):
        ref = self.add_style("特" * 5000)
        unused = self.add_style("不应该被发给写作模型")
        novel.mutate(self.p, "toggle_style_reference", {"id": ref["id"], "active": True})
        c = self.p["chapters"][1]
        self.p["style_reference_mode"] = "card"
        context = novel.build_context(self.p, c)
        self.assertNotIn("sample", context["style"])
        self.assertFalse(context["style_samples"])
        novel.mutate(self.p, "set_reference_mode", {"mode": "samples"})
        context = novel.build_context(self.p, c)
        self.assertEqual(len(context["style_samples"]), 1)
        self.assertEqual(len(context["style_samples"][0]["excerpt"]), 4000)
        self.assertTrue(context["style_samples"][0]["truncated"])
        self.assertNotIn(unused["text"], json.dumps(context, ensure_ascii=False))

    def test_max_three_active_samples(self):
        refs = [self.add_style(str(i)) for i in range(4)]
        for ref in refs[:3]:
            novel.mutate(self.p, "toggle_style_reference", {"id": ref["id"], "active": True})
        with self.assertRaisesRegex(novel.StoryError, "最多启用3份"):
            novel.mutate(self.p, "toggle_style_reference", {"id": refs[3]["id"], "active": True})

    def test_picture_analysis_never_changes_character_until_selected(self):
        before = copy.deepcopy(self.p["entities"])
        ref = self.add_character()
        self.assertEqual(self.p["entities"], before)
        self.assertNotIn("无依据", ref["analysis"]["character"]["base"]["appearance"])
        hero = self.p["entities"][0]
        old_goal = hero["base"]["goal"]
        novel.mutate(self.p, "apply_character_reference", {"id": ref["id"], "entity_id": hero["id"], "fields": ["appearance"],
                     "values": {"appearance": "短发，蓝色外套", "goal": "未选中，不应改变"}})
        hero = self.p["entities"][0]
        self.assertEqual(hero["base"]["appearance"], "短发，蓝色外套")
        self.assertEqual(hero["base"]["goal"], old_goal)
        self.assertEqual(hero["description"], before[0]["description"])
        self.assertIn(ref["id"], hero["reference_ids"])
        self.assertEqual(self.p["chapters"][0]["status"], "needs_review")

    def test_create_character_from_image_has_no_unselected_biography(self):
        ref = self.add_character()
        novel.mutate(self.p, "apply_character_reference", {"id": ref["id"], "name": "新人物", "fields": ["appearance"], "values": {"appearance": "深色外套"}})
        new = self.p["entities"][-1]
        self.assertEqual(new["name"], "新人物")
        self.assertEqual(new["description"], "")
        self.assertEqual(new["base"]["goal"], "")
        self.assertEqual(new["base"]["appearance"], "深色外套")

    def test_correction_history_is_bounded_and_keeps_independent_snapshots(self):
        ref = self.add_character()
        before_entities = copy.deepcopy(self.p["entities"])
        original = copy.deepcopy(ref["analysis"])
        for i in range(12):
            novel.save_reference_analysis(self.p, ref["id"], character_result(), feedback=f"第{i + 1}次：保留蓝色外套，修正头发。")
        self.assertEqual(len(ref["analysis_history"]), 10)
        self.assertEqual(ref["analysis_history"][0]["analysis"]["feedback"], "第2次：保留蓝色外套，修正头发。")
        self.assertEqual(ref["analysis_history"][-1]["analysis"]["feedback"], "第11次：保留蓝色外套，修正头发。")
        self.assertTrue(all(entry["replaced_at"] for entry in ref["analysis_history"]))
        ref["analysis"]["observations"]["appearance"] = "当前候选被编辑"
        self.assertEqual(ref["analysis_history"][-1]["analysis"]["observations"]["appearance"], original["observations"]["appearance"])
        context = novel.reference_context(self.p, ref, "现在修正表情")
        context["reference_correction"]["previous_analysis"]["observations"]["appearance"] = "上下文被编辑"
        self.assertEqual(ref["analysis"]["observations"]["appearance"], "当前候选被编辑")
        self.assertEqual(self.p["entities"], before_entities)
        self.assertEqual(self.p["chapters"][0]["status"], "approved")

    def test_full_reanalysis_starts_new_feedback_chain_but_keeps_history(self):
        ref = self.add_character()
        first = copy.deepcopy(ref["analysis"])
        novel.save_reference_analysis(self.p, ref["id"], character_result(), feedback="头发是长发，请保留衣着。")
        context = novel.reference_context(self.p, ref, "表情更平静")
        self.assertEqual(context["reference_correction"]["feedback_history"], ["头发是长发，请保留衣着。"])
        self.assertEqual(ref["analysis_history"][0]["analysis"], first)
        novel.save_reference_analysis(self.p, ref["id"], character_result())
        self.assertNotIn("feedback", ref["analysis"])
        self.assertEqual(len(ref["analysis_history"]), 2)
        self.assertNotIn("reference_correction", novel.reference_context(self.p, ref))
        context = novel.reference_context(self.p, ref, "从这版开始修正表情")
        self.assertEqual(context["reference_correction"]["feedback_history"], [])
        self.assertEqual(context["reference_correction"]["previous_analysis"], ref["analysis"])

    def test_locked_character_rejects_picture_changes(self):
        ref = self.add_character()
        hero = self.p["entities"][0]
        hero["locked"] = True
        with self.assertRaisesRegex(novel.StoryError, "锁定"):
            novel.mutate(self.p, "apply_character_reference", {"id": ref["id"], "entity_id": hero["id"], "fields": ["appearance"], "values": {"appearance": "不能写入"}})

    def test_reference_link_survives_manual_entity_edit(self):
        ref = self.add_character()
        hero = self.p["entities"][0]
        hero["reference_ids"] = [ref["id"]]
        payload = copy.deepcopy(hero)
        payload.pop("reference_ids")
        novel.mutate(self.p, "save_entity", payload)
        self.assertEqual(self.p["entities"][0]["reference_ids"], [ref["id"]])

    def test_upgrade_preserves_existing_sample_and_approval(self):
        self.p.pop("references")
        self.p.pop("style_reference_mode")
        novel.upgrade(self.p)
        self.assertEqual(self.p["style_reference_mode"], "samples")
        self.assertEqual(self.p["chapters"][0]["status"], "approved")

    def test_rejects_disguised_or_oversized_image(self):
        for raw in (b"<svg onload='alert(1)'></svg>", b"x" * (4 * 1024 * 1024 + 1)):
            with self.assertRaises(novel.StoryError):
                app.prepare_image({"title": "坏图片", "base64": base64.b64encode(raw).decode()})
        with self.assertRaises(novel.StoryError):
            app.prepare_image({"title": "坏数据", "base64": "not base64!"})


class ReferenceHTTPTests(unittest.TestCase):
    setUp = support.HTTPTests.setUp
    tearDown = support.HTTPTests.tearDown
    request = support.HTTPTests.request
    setup_provider = support.HTTPTests.setup_provider

    def upload_image(self):
        p = self.server.store.get(self.pid)
        _, raw = self.request(f"/api/projects/{self.pid}/reference-image", {"revision": p["revision"], "title": "测试参考图", "base64": PNG})
        return json.loads(raw)["project"]

    def add_style(self):
        p = self.server.store.get(self.pid)
        _, raw = self.request(f"/api/projects/{self.pid}/mutate", {"revision": p["revision"], "action": "save_style_reference", "data": {"title": "示例", "text": "他放下杯子。窗外的雨还没停。"}})
        return json.loads(raw)["project"]

    def analyze_image(self, p, **extra):
        _, raw = self.request(f"/api/projects/{self.pid}/analyze-reference", {"revision": p["revision"], "id": p["references"][0]["id"], **extra})
        return json.loads(raw)["project"]

    def test_style_analysis_then_apply(self):
        self.setup_provider()
        p = self.add_style()
        rid = p["references"][0]["id"]
        before = p["style"]
        _, raw = self.request(f"/api/projects/{self.pid}/analyze-reference", {"revision": p["revision"], "id": rid})
        p = json.loads(raw)["project"]
        self.assertEqual(p["style"], before)
        self.assertIsNotNone(p["references"][0]["analysis"])
        _, raw = self.request(f"/api/projects/{self.pid}/mutate", {"revision": p["revision"], "action": "apply_style_analysis", "data": {"id": rid, "fields": ["rhythm"], "values": {"rhythm": "短句。"}}})
        self.assertEqual(json.loads(raw)["project"]["style"]["rhythm"], "短句。")

    def test_vision_payload_uses_image_and_separate_model(self):
        self.request("/api/settings", {"base_url": f"http://127.0.0.1:{self.provider.server_port}/v1", "model": "text-model", "vision_model": "vision-model", "max_tokens": 6000})
        p = self.upload_image()
        rid = p["references"][0]["id"]
        _, raw = self.request(f"/api/projects/{self.pid}/analyze-reference", {"revision": p["revision"], "id": rid})
        after = json.loads(raw)["project"]
        self.assertEqual(after["entities"], p["entities"])
        self.assertIn("observations", after["references"][0]["analysis"])
        sent = support.ProviderHandler.requests[-1]
        self.assertEqual(sent["model"], "vision-model")
        parts = sent["messages"][1]["content"]
        self.assertEqual(parts[0]["type"], "text")
        self.assertEqual(parts[1]["image_url"]["url"], f"data:image/png;base64,{PNG}")

    def test_corrections_send_original_image_previous_analysis_and_feedback_chain(self):
        self.setup_provider()
        p = self.analyze_image(self.upload_image())
        original = copy.deepcopy(p)
        first_feedback = "头发其实是长发，请保留蓝色外套和其他设定。"
        p = self.analyze_image(p, feedback=first_feedback)
        sent = support.ProviderHandler.requests[-1]
        parts = sent["messages"][1]["content"]
        payload = json.loads(parts[0]["text"])
        self.assertEqual(parts[1]["image_url"]["url"], f"data:image/png;base64,{PNG}")
        self.assertEqual(payload["author_instructions"], first_feedback)
        correction = payload["context"]["reference_correction"]
        self.assertEqual(correction["previous_analysis"], original["references"][0]["analysis"])
        self.assertEqual(correction["feedback_history"], [])
        self.assertEqual(p["references"][0]["analysis"]["feedback"], first_feedback)
        self.assertEqual(p["references"][0]["analysis_history"][0]["analysis"], original["references"][0]["analysis"])
        prior_analysis = copy.deepcopy(p["references"][0]["analysis"])
        second_feedback = "嘴角应当略微上扬，之前对长发的修正继续保留。"
        p = self.analyze_image(p, feedback=second_feedback)
        payload = json.loads(support.ProviderHandler.requests[-1]["messages"][1]["content"][0]["text"])
        self.assertEqual(payload["author_instructions"], second_feedback)
        self.assertEqual(payload["context"]["reference_correction"]["previous_analysis"], prior_analysis)
        self.assertEqual(payload["context"]["reference_correction"]["feedback_history"], [first_feedback])
        self.assertEqual(len(p["references"][0]["analysis_history"]), 2)
        self.assertEqual(p["entities"], original["entities"])
        self.assertEqual(p["chapters"], original["chapters"])

    def test_invalid_feedback_is_rejected_before_model_and_preserves_analysis(self):
        self.setup_provider()
        p = self.analyze_image(self.upload_image())
        count = len(support.ProviderHandler.requests)
        for feedback in ("", " \n\t", "长" * 5001, None, 42, ["长发"], {"appearance": "长发"}):
            with self.subTest(feedback_type=type(feedback).__name__, length=len(feedback) if isinstance(feedback, str) else None):
                with self.assertRaises(HTTPError) as cm:
                    self.analyze_image(p, feedback=feedback)
                self.assertEqual(cm.exception.code, 400)
                self.assertEqual(self.server.store.get(self.pid), p)
                self.assertEqual(len(support.ProviderHandler.requests), count)

    def test_feedback_requires_existing_character_analysis(self):
        self.setup_provider()
        p = self.upload_image()
        with self.assertRaises(HTTPError) as cm:
            self.analyze_image(p, feedback="请把头发改成长发。")
        self.assertEqual(cm.exception.code, 400)
        self.assertEqual(self.server.store.get(self.pid), p)
        self.assertEqual(support.ProviderHandler.requests, [])
        p = self.add_style()
        rid = p["references"][-1]["id"]
        _, raw = self.request(f"/api/projects/{self.pid}/analyze-reference", {"revision": p["revision"], "id": rid})
        p = json.loads(raw)["project"]
        count = len(support.ProviderHandler.requests)
        with self.assertRaises(HTTPError) as cm:
            self.request(f"/api/projects/{self.pid}/analyze-reference", {"revision": p["revision"], "id": rid, "feedback": "改为长句。"})
        self.assertEqual(cm.exception.code, 400)
        self.assertEqual(self.server.store.get(self.pid), p)
        self.assertEqual(len(support.ProviderHandler.requests), count)

    def test_correction_model_errors_preserve_existing_analysis_and_history(self):
        self.setup_provider()
        p = self.analyze_image(self.upload_image())
        p = self.analyze_image(p, feedback="头发是长发。")
        for mode in ("bad", "length"):
            support.ProviderHandler.mode = mode
            with self.subTest(mode=mode), self.assertRaises(HTTPError) as cm:
                self.analyze_image(p, feedback="再修正衣服的颜色。")
            self.assertEqual(cm.exception.code, 400)
            self.assertEqual(self.server.store.get(self.pid), p)

    def test_stale_and_concurrent_corrections_preserve_existing_analysis_history(self):
        self.setup_provider()
        p = self.analyze_image(self.upload_image())
        p = self.analyze_image(p, feedback="头发是长发。")
        count = len(support.ProviderHandler.requests)
        with self.assertRaises(HTTPError) as cm:
            self.request(f"/api/projects/{self.pid}/analyze-reference", {"revision": p["revision"] - 1, "id": p["references"][0]["id"], "feedback": "修正表情。"})
        self.assertEqual(cm.exception.code, 409)
        self.assertEqual(self.server.store.get(self.pid), p)
        self.assertEqual(len(support.ProviderHandler.requests), count)

        def competing_call(*args, **kwargs):
            self.server.store.update(self.pid, p["revision"], lambda current: current.update(title="另一窗口的修改"))
            return character_result()

        with patch("app.call_model", side_effect=competing_call):
            with self.assertRaises(HTTPError) as cm:
                self.analyze_image(p, feedback="修正表情。")
        self.assertEqual(cm.exception.code, 409)
        saved = self.server.store.get(self.pid)
        self.assertEqual(saved["title"], "另一窗口的修改")
        self.assertEqual(saved["references"], p["references"])
        self.assertEqual(saved["entities"], p["entities"])

    def test_image_persists_and_backup_contains_bytes(self):
        p = self.upload_image()
        rid = p["references"][0]["id"]
        code, raw = self.request(f"/api/projects/{self.pid}/references/{rid}/image")
        self.assertEqual(code, 200)
        self.assertEqual(raw, base64.b64decode(PNG))
        reopened = app.Store(self.server.store.path)
        self.assertEqual(reopened.image(self.pid, rid)["data"], raw)
        _, raw = self.request(f"/api/projects/{self.pid}/backup")
        backup = json.loads(raw)
        self.assertEqual(backup["images"][0]["base64"], PNG)
        self.assertNotIn("base64", p["references"][0])

    def test_image_cannot_be_accessed_from_another_project(self):
        p = self.upload_image()
        rid = p["references"][0]["id"]
        other = self.server.store.insert(novel.new_project("另一本书"))
        with self.assertRaises(HTTPError) as cm:
            self.request(f"/api/projects/{other['id']}/references/{rid}/image")
        self.assertEqual(cm.exception.code, 404)

    def test_stale_upload_does_not_leave_orphaned_asset(self):
        p = self.upload_image()
        with self.assertRaises(HTTPError) as cm:
            self.request(f"/api/projects/{self.pid}/reference-image", {"revision": 0, "title": "过期提交", "base64": PNG})
        self.assertEqual(cm.exception.code, 409)
        self.assertEqual(self.server.store.get(self.pid), p)
        self.assertEqual(len(self.server.store.backup(self.pid)["images"]), 1)

    def test_invalid_model_result_does_not_change_reference_or_canon(self):
        self.setup_provider()
        p = self.upload_image()
        support.ProviderHandler.mode = "bad"
        with self.assertRaises(HTTPError) as cm:
            self.request(f"/api/projects/{self.pid}/analyze-reference", {"revision": p["revision"], "id": p["references"][0]["id"]})
        self.assertEqual(cm.exception.code, 400)
        self.assertEqual(self.server.store.get(self.pid), p)

    def test_concurrent_edit_during_analysis_is_not_overwritten(self):
        self.setup_provider()
        p = self.add_style()
        def competing_call(*args, **kwargs):
            self.server.store.update(self.pid, p["revision"], lambda current: current.update(title="另一窗口的修改"))
            return style_result()
        with patch("app.call_model", side_effect=competing_call):
            with self.assertRaises(HTTPError) as cm:
                self.request(f"/api/projects/{self.pid}/analyze-reference", {"revision": p["revision"], "id": p["references"][0]["id"]})
        self.assertEqual(cm.exception.code, 409)
        saved = self.server.store.get(self.pid)
        self.assertEqual(saved["title"], "另一窗口的修改")
        self.assertIsNone(saved["references"][0]["analysis"])


if __name__ == "__main__":
    unittest.main()
