"""Reviewable AI plans. Generating a suggestion never changes an author's draft."""
import copy
import hashlib
import json

import novel
import outline as story_outline


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def _check_source(p, data, value):
    if type(data.get("source_revision")) is not int or data["source_revision"] != p["revision"]:
        raise novel.StoryError("作品已更新，这份候选已过期。原稿与候选均已保留，请重新生成后采用。")
    if data.get("source_hash") != _hash(value):
        raise novel.StoryError("原方案已改变，这份候选已过期。请重新生成后采用。")


def outline_preview(p, result):
    book = story_outline.ensure(p)
    if not isinstance(result, dict) or not isinstance(result.get("nodes"), list) or not result["nodes"]:
        raise novel.StoryError("模型没有返回有效的阶段节点，现有大纲已保留。")
    if any(not isinstance(node, dict) for node in result["nodes"]):
        raise novel.StoryError("模型返回的节点格式无效，现有大纲已保留。")
    source = copy.deepcopy(book["draft"])
    draft = {**source, "nodes": [{**node, "id": novel.uid()} for node in result["nodes"]]}
    if not draft["ending"]:
        draft["ending"] = novel.bounded_string(result.get("ending", ""), 5000)
    draft = story_outline.clean_draft(draft, require_nodes=True, allow_open_ending=True)
    return {"kind": "outline", "source_revision": p["revision"], "source_hash": _hash(source),
            "original": source, "draft": draft}


def checkpoint_outline(book, reason):
    history = book.setdefault("draft_history", [])
    draft = copy.deepcopy(book["draft"])
    if history and history[-1]["draft"] == draft:
        return
    history.append({"id": novel.uid(), "at": novel.now(), "reason": reason, "draft": draft})
    book["draft_history"] = history[-20:]


def adopt_outline(p, data):
    book = story_outline.ensure(p)
    _check_source(p, data, book["draft"])
    mode = data.get("mode")
    if mode not in ("replace", "append"):
        raise novel.StoryError("请选择替换节点或追加节点。")
    candidate = data.get("draft")
    if not isinstance(candidate, dict) or not isinstance(candidate.get("nodes"), list) or not candidate["nodes"]:
        raise novel.StoryError("请至少选择一个候选节点后再采用。")
    # Original author text, constraints and an existing ending cannot be replaced
    # by a model suggestion. The author can edit them normally on the outline page.
    draft = copy.deepcopy(book["draft"])
    draft["nodes"] = (draft["nodes"] if mode == "append" else []) + copy.deepcopy(candidate["nodes"])
    if not draft["ending"]:
        draft["ending"] = novel.bounded_string(candidate.get("ending", ""), 5000)
    cleaned = story_outline.clean_draft(draft, require_nodes=True, allow_open_ending=True)
    checkpoint_outline(book, "采用AI节点前的大纲草稿")
    book["draft"] = cleaned
    novel.log(p, f"已{'追加' if mode == 'append' else '采用'}作者选择的{len(candidate['nodes'])}个阶段节点，尚未生效。")


def restore_outline_draft(p, data):
    book = story_outline.ensure(p)
    old = next((item for item in book["draft_history"] if item["id"] == data.get("history_id")), None)
    if not old:
        raise novel.StoryError("大纲草稿历史不存在。")
    draft = story_outline.clean_draft(copy.deepcopy(old["draft"]))
    checkpoint_outline(book, "恢复历史前的大纲草稿")
    book["draft"] = draft
    novel.log(p, "已恢复大纲草稿，当前生效走向保持原样。")


def _plan_source(c):
    return {key: c.get(key) for key in ("id", "outline", "text", "intent", "node_id", "completes_node")}


def plan_preview(p, c, result):
    if not isinstance(result, dict):
        raise novel.StoryError("模型没有返回有效场景方案，原稿已保留。")
    outline = novel.bounded_string(result.get("outline", ""), 10000)
    if not outline.strip():
        raise novel.StoryError("模型没有返回场景方案，原稿已保留。")
    return {"kind": "plan", "chapter_id": c["id"], "source_revision": p["revision"],
            "source_hash": _hash(_plan_source(c)), "original": c["outline"], "outline": outline}


def adopt_plan(p, data):
    c = novel.get_chapter(p, data.get("chapter_id"))
    _check_source(p, data, _plan_source(c))
    outline = novel.bounded_string(data.get("outline", ""), 10000)
    if not outline.strip():
        raise novel.StoryError("场景方案不能为空。原方案已保留。")
    if outline == c["outline"]:
        return
    novel.snapshot(c, "采用AI场景方案前的版本")
    c.update(outline=outline, updated_at=novel.now())
    novel.log(p, f"《{c['title']}》已采用作者核对后的场景方案，原方案已保留在历史版本中。")
