"""Reviewable chapter memories derived from prose, without rewriting that prose."""
import copy

import novel


def _chapter(p, c):
    if novel.get_chapter(p, c.get("id")) is not c:
        raise novel.StoryError("章节已经改变，请重新打开章节记忆。")
    if not isinstance(c.get("text"), str) or not c["text"].strip():
        raise novel.StoryError("请先写入正文，再整理章节记忆。")
    return c


def context(p, c):
    """Use only this prose and already confirmed history; never future plot plans."""
    _chapter(p, c)
    previous = []
    for earlier in p["chapters"]:
        if earlier["id"] == c["id"]:
            break
        if earlier["status"] == "approved":
            previous.append({"title": earlier["title"], "summary": earlier["accepted_summary"]})
    entities = [{key: copy.deepcopy(entity[key])
                 for key in ("id", "kind", "name", "description", "locked", "state", "sources")}
                for entity in novel.canon(p, before=c["id"])]
    return {"chapter": {"title": c["title"], "text": c["text"]}, "entities": entities,
            "previous_chapters": previous, "fields": copy.deepcopy(novel.FIELDS)}


def _base(p, c):
    _chapter(p, c)
    return {"kind": "memory", "chapter_id": c["id"], "source_revision": p["revision"],
            "source_hash": novel._text_hash(c["text"]),
            "original": {"summary": c["summary"], "changes": copy.deepcopy(c["changes"])}}


def _summary(value):
    value = novel.bounded_string(value, 10000)
    if not value.strip():
        raise novel.StoryError("章节摘要不能为空，请填写本章已经发生的事实。")
    return value


def _target_problem(entities, item):
    entity = entities.get(item["entity_id"])
    if not entity:
        return "指向了不存在的人物或设定，请删除此项并先建立档案。"
    if item["field"] not in novel.FIELDS.get(entity["kind"], {}):
        return f"「{entity['name']}」的状态字段无效，请改选有效字段。"
    return None


def _value_problem(entities, c, item):
    problem = _target_problem(entities, item)
    if problem:
        return problem
    entity = entities[item["entity_id"]]
    if entity["locked"]:
        return f"「{entity['name']}」已锁定，请先在档案中解锁后再采用变化。"
    if not item["value"].strip():
        return f"「{entity['name']}」的状态内容为空，请填写后再勾选。"
    if not item["evidence"].strip() or item["evidence"] not in c["text"]:
        return f"「{entity['name']}」的原文依据不在当前正文中，请逐字引用本章文字。"
    return None


def preview(p, c, result):
    """Filter invalid model proposals visibly. No proposal becomes confirmed canon."""
    base = _base(p, c)
    if not isinstance(result, dict) or "summary" not in result or "changes" not in result:
        raise novel.StoryError("模型没有返回有效的章节摘要和状态候选，现有记忆已保留。")
    summary = _summary(result["summary"])
    raw = result["changes"]
    if not isinstance(raw, list) or len(raw) > 100:
        raise novel.StoryError("状态候选必须是列表且不超过100项，现有记忆已保留。")
    entities = {entity["id"]: entity for entity in p["entities"]}
    changes, warnings, seen = [], [], set()
    for index, item in enumerate(raw, 1):
        try:
            if not isinstance(item, dict):
                raise novel.StoryError("状态变化格式不正确。")
            # Model IDs and selection flags cannot imply an author's choice.
            clean = novel.normalize_changes([{**item, "id": novel.uid(), "selected": False}])[0]
            problem = _value_problem(entities, c, clean)
            key = (clean["entity_id"], clean["field"])
            if not problem and key in seen:
                problem = "同一状态字段出现多个候选，请整理为一个最终值。"
            if problem:
                raise novel.StoryError(problem)
            seen.add(key)
            changes.append(clean)
        except novel.StoryError as exc:
            warnings.append(f"第{index}项状态候选未保留：{exc}")
    return {**base, "summary": summary, "changes": changes, "warnings": warnings}


def current_preview(p, c):
    """Open the existing memory for author edits; no model or storage writes needed."""
    base = _base(p, c)
    changes = novel.normalize_changes(c["changes"])
    entities = {entity["id"]: entity for entity in p["entities"]}
    warnings, selected = [], set()
    for index, item in enumerate(changes, 1):
        problem = _value_problem(entities, c, item)
        key = (item["entity_id"], item["field"])
        if not problem and item["selected"] and key in selected:
            problem = "同一状态字段只能勾选一个最终值。"
        if problem:
            item["selected"] = False
            warnings.append(f"第{index}项已取消勾选，仍保留供修改：{problem}")
        elif item["selected"]:
            selected.add(key)
    return {**base, "manual": True, "summary": c["summary"], "changes": changes,
            "warnings": warnings}


def adopt(p, data):
    """Save author-reviewed memory candidates; approval remains a separate action."""
    if not isinstance(data, dict):
        raise novel.StoryError("章节记忆格式不正确。")
    c = novel.get_chapter(p, data.get("chapter_id"))
    _chapter(p, c)
    if type(data.get("source_revision")) is not int or data["source_revision"] != p["revision"]:
        raise novel.StoryError("作品已更新，这份章节记忆预览已过期。请保留修改后重新打开。")
    source_hash = novel.bounded_string(data.get("source_hash", ""), 64)
    if source_hash != novel._text_hash(c["text"]):
        raise novel.StoryError("正文已经改变，请重新整理章节记忆。")
    summary = _summary(data.get("summary"))
    if "changes" not in data:
        raise novel.StoryError("请提供状态候选列表；本章无变化时可使用空列表。")
    changes = novel.normalize_changes(data["changes"])
    entities = {entity["id"]: entity for entity in p["entities"]}
    ids = set()
    for item in changes:
        problem = _target_problem(entities, item)
        if not problem and item["selected"]:
            problem = _value_problem(entities, c, item)
        if problem:
            raise novel.StoryError(problem)
        if item["id"] in ids:
            raise novel.StoryError("状态候选标识重复，请重新整理候选。")
        ids.add(item["id"])
    # Unselected candidates may retain an unfinished value or quote for later editing.
    # Only explicit, valid selections can pass the existing canon approval validator.
    novel.validate_changes(p, {**c, "changes": changes})
    if c["summary"] == summary and c["changes"] == changes:
        return
    # Everything above is validation. Checkpoints and invalidation begin only now.
    novel.snapshot(c, "采用章节记忆前的版本")
    affected = novel.invalidate(p, c["id"], True)
    if c.get("review"):
        c["review"]["stale_reason"] = "章节摘要或状态候选已改变，请重新审稿。"
    c.update(summary=summary, changes=changes, local_edit_review_required=True, updated_at=novel.now())
    message = f"《{c['title']}》已更新章节记忆，等待作者核对并确认入库。"
    if affected:
        message += f"{len(affected)}章等待复核。"
    novel.log(p, message)
