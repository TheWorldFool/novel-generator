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


def _rewrite_source(c):
    return {key: copy.deepcopy(c.get(key)) for key in
            ("id", "text", "summary", "changes", "outline", "intent", "cast", "node_id", "completes_node")}


def _rewrite_problem(p, text, item, *, selected=False):
    entity = next((e for e in p["entities"] if e["id"] == item["entity_id"]), None)
    if not entity or item["field"] not in novel.FIELDS.get(entity["kind"], {}):
        return "状态候选指向了不存在的人物、设定或字段，请改选有效档案。"
    if selected:
        if entity["locked"]:
            return f"「{entity['name']}」已锁定，请先解锁或取消勾选。"
        if not item["value"].strip():
            return "已勾选的状态内容不能为空。"
        if not item["evidence"].strip() or item["evidence"] not in text:
            return "已勾选的原文依据不在候选正文中，请逐字核对。"
    return None


def rewrite_preview(p, c, result):
    """A whole-chapter suggestion is read-only until explicit author adoption."""
    if novel.get_chapter(p, c.get("id")) is not c or not c["text"].strip():
        raise novel.StoryError("请先写入正文，再生成整章修订候选。")
    if not isinstance(result, dict):
        raise novel.StoryError("模型没有返回有效修订，原稿已保留。")
    text = novel.bounded_string(result.get("text", ""), 100000)
    summary = novel.bounded_string(result.get("summary", ""), 10000)
    if not text.strip() or not summary.strip():
        raise novel.StoryError("模型没有返回正文或摘要，原稿已保留。")
    raw = result.get("changes", [])
    if not isinstance(raw, list) or len(raw) > 100:
        raise novel.StoryError("状态候选必须是列表且不超过100项，原稿已保留。")
    changes, warnings, seen = [], [], set()
    for index, item in enumerate(raw, 1):
        try:
            if not isinstance(item, dict):
                raise novel.StoryError("状态变化格式不正确。")
            clean = novel.normalize_changes([{**item, "id": novel.uid(), "selected": False}])[0]
            problem = _rewrite_problem(p, text, clean, selected=True)
            field = (clean["entity_id"], clean["field"])
            if not problem and field in seen:
                problem = "同一状态字段存在多个候选，请整理为最终值。"
            if problem:
                raise novel.StoryError(problem)
            changes.append(clean)
            seen.add(field)
        except novel.StoryError as error:
            warnings.append(f"第{index}项状态候选未保留：{error}")
    return {"kind": "rewrite", "chapter_id": c["id"], "source_revision": p["revision"],
            "source_hash": _hash(_rewrite_source(c)),
            "original": {"text": c["text"], "summary": c["summary"], "changes": copy.deepcopy(c["changes"])},
            "text": text, "summary": summary, "changes": changes, "warnings": warnings}


def adopt_rewrite(p, data):
    """Validate everything before checkpointing or replacing any work in progress."""
    if not isinstance(data, dict):
        raise novel.StoryError("整章修订格式不正确。")
    c = novel.get_chapter(p, data.get("chapter_id"))
    _check_source(p, data, _rewrite_source(c))
    if not c["text"].strip():
        raise novel.StoryError("请先写入正文，再采用整章修订。")
    text = novel.bounded_string(data.get("text", ""), 100000)
    summary = novel.bounded_string(data.get("summary", ""), 10000)
    if not text.strip() or not summary.strip():
        raise novel.StoryError("候选正文和摘要不能为空，原稿已保留。")
    if "changes" not in data:
        raise novel.StoryError("请提供状态候选列表，本章无变化时可使用空列表。")
    changes = novel.normalize_changes(data["changes"])
    ids = set()
    for item in changes:
        problem = _rewrite_problem(p, text, item, selected=item["selected"])
        if problem:
            raise novel.StoryError(problem)
        if item["id"] in ids:
            raise novel.StoryError("状态候选标识重复，请删除重复项。")
        ids.add(item["id"])
    novel.validate_changes(p, {**c, "text": text, "changes": changes})
    if all(c[key] == value for key, value in (("text", text), ("summary", summary), ("changes", changes))):
        return
    novel.snapshot(c, "采用整章修订前的版本")
    novel.invalidate(p, c["id"], True)
    c.update(text=text, summary=summary, changes=changes, review=None,
             local_edit_review_required=True, outline_checked_version=0,
             status="needs_review" if c.get("accepted_text") else "draft", updated_at=novel.now())
    if c.get("node_evidence") and c["node_evidence"] not in text:
        c["node_evidence"] = ""
    novel.log(p, f"《{c['title']}》已采用作者核对的整章修订，原稿保留在历史版本中；请核对摘要与状态后另行确认入库。")
