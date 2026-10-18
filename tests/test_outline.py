import copy
import json
import unittest
from urllib.error import HTTPError

import novel
import outline as story_outline
import test_workbench as support


def draft_outline():
    return {"text": "林照收到来信，调查港务所。找到旧案证据后公开真相，最终雾港重开。", "ending": "公开真相，雾港重开", "guardrails": "不能让主角靠突然获得的能力解决旧案", "nodes": [
        {"id": "investigation", "title": "调查港务所", "goal": "拿到旧案线索", "must": "收到来信并调查", "avoid": "不提前公开真相", "source_quote": "林照收到来信，调查港务所。"},
        {"id": "reveal", "title": "公开真相", "goal": "揭开旧案，重开雾港", "must": "公开证据", "avoid": "不改变既定结局", "source_quote": "找到旧案证据后公开真相，最终雾港重开。"}
    ]}


def activate(p):
    novel.mutate(p, "save_book_outline", draft_outline())
    novel.mutate(p, "publish_book_outline", {})
    return p


def approve_first(p, completes=True):
    c=p["chapters"][0]
    novel.mutate(p, "save_chapter", {"id": c["id"], "node_id": "investigation", "completes_node": completes,
                                    "text": "林照收到来信，随后在港务所拿到了旧案的线索。", "summary": "林照得到旧案线索。", "changes": [],
                                    "node_evidence": "在港务所拿到了旧案的线索" if completes else ""})
    novel.approve(p, c["id"], outline_checked=True)


class OutlineDomainTests(unittest.TestCase):
    def setUp(self):
        self.p=novel.upgrade(novel.demo_project())

    def test_saving_draft_does_not_change_live_direction_or_chapters(self):
        before=copy.deepcopy(self.p["chapters"])
        novel.mutate(self.p,"save_book_outline",draft_outline())
        self.assertIsNone(self.p["book_outline"]["active"])
        self.assertEqual(self.p["chapters"],before)

    def test_generation_requires_published_outline_and_node(self):
        with self.assertRaisesRegex(novel.StoryError,"全书大纲"):
            story_outline.require_ready(self.p,self.p["chapters"][0])
        activate(self.p)
        with self.assertRaisesRegex(novel.StoryError,"选择一个"):
            story_outline.require_ready(self.p,self.p["chapters"][0])

    def test_publishing_requires_ending_and_valid_source_quotes(self):
        draft=draft_outline();draft["ending"]=""
        novel.mutate(self.p,"save_book_outline",draft)
        with self.assertRaisesRegex(novel.StoryError,"结局"):
            novel.mutate(self.p,"publish_book_outline",{})
        draft=draft_outline();draft["nodes"][0]["source_quote"]="不存在的文字"
        novel.mutate(self.p,"save_book_outline",draft)
        with self.assertRaisesRegex(novel.StoryError,"原文依据"):
            novel.mutate(self.p,"publish_book_outline",{})

    def test_author_source_preserved_when_model_splits(self):
        draft=draft_outline();draft["nodes"]=[];draft["ending"]=""
        novel.mutate(self.p,"save_book_outline",draft)
        result={"text":"模型不能改写这份原文", "ending":"", "nodes":draft_outline()["nodes"]}
        story_outline.save_proposal(self.p,result)
        self.assertEqual(self.p["book_outline"]["draft"]["text"],draft["text"])
        self.assertEqual(self.p["book_outline"]["draft"]["ending"],"")
        self.assertIsNone(self.p["book_outline"]["active"])
        self.assertNotEqual(self.p["book_outline"]["draft"]["nodes"][0]["id"],"investigation")

    def test_publishing_invalidates_approved_chapters_and_keeps_history(self):
        activate(self.p)
        self.assertEqual(self.p["chapters"][0]["status"],"needs_review")
        approve_first(self.p)
        old=copy.deepcopy(self.p["book_outline"]["active"])
        draft=copy.deepcopy(old);draft["guardrails"]+="；主角必须亲自公开证据"
        novel.mutate(self.p,"save_book_outline",draft)
        self.assertEqual(self.p["chapters"][0]["status"],"approved")
        self.assertEqual(self.p["book_outline"]["active"],old)
        novel.mutate(self.p,"publish_book_outline",{})
        self.assertEqual(self.p["book_outline"]["version"],2)
        self.assertEqual(self.p["book_outline"]["history"][0]["outline"],old)
        self.assertEqual(self.p["chapters"][0]["status"],"needs_review")
        self.assertEqual(self.p["chapters"][0]["outline_checked_version"],0)

    def test_restoring_outline_changes_draft_only(self):
        activate(self.p)
        changed=draft_outline();changed["ending"]="公开真相，但雾港永不复航"
        novel.mutate(self.p,"save_book_outline",changed)
        novel.mutate(self.p,"publish_book_outline",{})
        novel.mutate(self.p,"restore_book_outline",{"version":1})
        self.assertEqual(self.p["book_outline"]["draft"]["ending"],draft_outline()["ending"])
        self.assertEqual(self.p["book_outline"]["active"]["ending"],changed["ending"])
        self.assertEqual(self.p["book_outline"]["version"],2)

    def test_cannot_skip_a_node(self):
        activate(self.p)
        first=self.p["chapters"][0];first["node_id"]="reveal"
        with self.assertRaisesRegex(novel.StoryError,"不能跳过"):
            story_outline.require_ready(self.p,first)

    def test_node_may_span_multiple_chapters_until_author_confirms_completion(self):
        activate(self.p);approve_first(self.p,completes=False)
        second=self.p["chapters"][1];second["node_id"]="investigation"
        self.assertEqual(story_outline.require_ready(self.p,second)["id"],"investigation")
        second["node_id"]="reveal"
        with self.assertRaisesRegex(novel.StoryError,"不能跳过"):
            story_outline.require_ready(self.p,second)

    def test_next_node_opens_only_after_approved_completion(self):
        activate(self.p);approve_first(self.p)
        second=self.p["chapters"][1];second["node_id"]="reveal"
        self.assertEqual(story_outline.require_ready(self.p,second)["id"],"reveal")
        second["node_id"]="investigation"
        with self.assertRaisesRegex(novel.StoryError,"已完成"):
            story_outline.require_ready(self.p,second)

    def test_completion_requires_author_acknowledgement_and_prose_evidence(self):
        activate(self.p)
        first=self.p["chapters"][0];first.update(node_id="investigation",completes_node=True,node_evidence="没有发生的事")
        with self.assertRaisesRegex(novel.StoryError,"勾选"):
            novel.approve(self.p,first["id"])
        with self.assertRaisesRegex(novel.StoryError,"完成依据"):
            novel.approve(self.p,first["id"],outline_checked=True)

    def test_mapping_change_invalidates_later_chapters(self):
        activate(self.p);approve_first(self.p)
        second=self.p["chapters"][1]
        second.update(node_id="reveal",text="林照公开了证据，雾港重新开放。",summary="公开证据，重开雾港。")
        novel.approve(self.p,second["id"],outline_checked=True)
        novel.mutate(self.p,"save_chapter",{"id":self.p["chapters"][0]["id"],"completes_node":False})
        self.assertTrue(all(c["status"]=="needs_review" for c in self.p["chapters"]))

    def test_context_has_current_stage_and_future_plan_not_current_facts(self):
        activate(self.p)
        first=self.p["chapters"][0];first["node_id"]="investigation"
        self.p["brief"]["ending"]="过时的结局"
        context=novel.build_context(self.p,first)
        direction=context["whole_book_direction"]
        self.assertEqual(direction["current_milestone"]["id"],"investigation")
        self.assertEqual(direction["future_milestones_not_yet_happened"][0]["id"],"reveal")
        self.assertFalse(direction["completed_milestones_before_this_chapter"])
        self.assertEqual(context["brief"]["ending"],draft_outline()["ending"])

    def test_preflight_reports_unbound_or_missing_outline(self):
        report=novel.preflight(self.p,self.p["chapters"][1])
        self.assertTrue(any(i["kind"]=="大纲" for i in report["issues"]))


class OutlineHTTPTests(unittest.TestCase):
    setUp=support.HTTPTests.setUp
    tearDown=support.HTTPTests.tearDown
    request=support.HTTPTests.request
    setup_provider=support.HTTPTests.setup_provider
    enable_outline=support.HTTPTests.enable_outline

    def test_no_outline_is_blocked_before_provider_call(self):
        self.setup_provider()
        p=self.server.store.get(self.pid)
        for action in ("plan","draft","rewrite"):
            with self.assertRaises(HTTPError) as cm:
                self.request(f"/api/projects/{self.pid}/ai",{"revision":p["revision"],"chapter_id":p["chapters"][1]["id"],"action":action})
            self.assertEqual(cm.exception.code,400)
        self.assertFalse(support.ProviderHandler.requests)

    def test_split_is_a_proposal_not_live_direction(self):
        self.setup_provider()
        p=self.server.store.get(self.pid)
        self.server.store.update(self.pid,p["revision"],lambda x:novel.mutate(x,"save_book_outline",draft_outline()))
        p=self.server.store.get(self.pid)
        _,raw=self.request(f"/api/projects/{self.pid}/outline-ai",{"revision":p["revision"]})
        after=json.loads(raw)["project"]
        self.assertIsNone(after["book_outline"]["active"])
        self.assertEqual(after["book_outline"]["draft"]["text"],draft_outline()["text"])
        self.assertEqual(len(after["book_outline"]["draft"]["nodes"]),2)
        self.assertEqual(after["chapters"],p["chapters"])

    def test_writing_request_carries_author_outline_and_bound_node(self):
        self.setup_provider();self.enable_outline()
        p=self.server.store.get(self.pid)
        self.request(f"/api/projects/{self.pid}/ai",{"revision":p["revision"],"chapter_id":p["chapters"][1]["id"],"action":"draft"})
        request=support.ProviderHandler.requests[-1]
        direction=json.loads(request["messages"][1]["content"])["context"]["whole_book_direction"]
        self.assertEqual(direction["current_milestone"]["id"],"investigate")
        self.assertEqual(direction["required_ending"],"公开证据")
        self.assertIn("不提前",request["messages"][0]["content"])


if __name__=="__main__":
    unittest.main()
