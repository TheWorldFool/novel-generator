"""Author-owned whole-book direction and chapter-to-milestone constraints."""
import copy
import json
import novel


def empty():
    return {"draft": {"text": "", "ending": "", "guardrails": "", "nodes": []}, "active": None, "version": 0, "history": [], "draft_history": []}


def ensure(p):
    p.setdefault("book_outline", empty())
    p["book_outline"].setdefault("draft_history", [])
    for c in p["chapters"]:
        c.setdefault("node_id", "")
        c.setdefault("completes_node", False)
        c.setdefault("node_evidence", "")
        c.setdefault("outline_checked_version", 0)
    return p["book_outline"]


def clean_draft(data, require_nodes=False, allow_open_ending=False):
    result = {key: novel.bounded_string(data.get(key, ""), 30000 if key == "text" else 5000).strip()
              for key in ("text", "ending", "guardrails")}
    nodes = data.get("nodes", [])
    if not isinstance(nodes, list) or len(nodes) > 30:
        raise novel.StoryError("全书最多设置30个阶段节点。")
    result["nodes"] = []
    seen = set()
    for node in nodes:
        if not isinstance(node, dict):
            raise novel.StoryError("大纲节点格式无效。")
        item = {key: novel.bounded_string(node.get(key, ""), 200 if key == "title" else 3000).strip()
                for key in ("title", "goal", "must", "avoid", "source_quote")}
        item["id"] = novel.bounded_string(node.get("id") or novel.uid(), 100)
        if item["id"] in seen:
            raise novel.StoryError("大纲节点不能重复。")
        seen.add(item["id"])
        if require_nodes and (not item["title"] or not item["goal"]):
            raise novel.StoryError("每个节点都需要标题和阶段目标。")
        if require_nodes and item["source_quote"] and item["source_quote"] not in result["text"]:
            raise novel.StoryError(f"节点「{item['title']}」的原文依据不在当前大纲中，请修正或清空该引用后重新核对。")
        result["nodes"].append(item)
    if require_nodes and (not result["text"] or (not result["ending"] and not allow_open_ending) or not nodes):
        raise novel.StoryError("请填写全书大纲、确定结局，并至少建立一个阶段节点。")
    if len(json.dumps(result, ensure_ascii=False)) > 65000:
        raise novel.StoryError("全书大纲与节点总量超过65000字符，请适当精简。")
    return result


def mutate(p, action, data):
    book = ensure(p)
    if action == "save_book_outline":
        book["draft"] = clean_draft(data)
    elif action == "publish_book_outline":
        active = clean_draft(book["draft"], require_nodes=True)
        if active == book["active"]:
            return
        if book["active"]:
            book["history"].append({"version": book["version"], "at": novel.now(), "outline": copy.deepcopy(book["active"])})
            book["history"] = book["history"][-20:]
        book["active"] = copy.deepcopy(active)
        book["version"] += 1
        affected = novel.invalidate(p, p["chapters"][0]["id"], True)
        for c in p["chapters"]:
            c["review"] = None
            c["outline_checked_version"] = 0
        novel.log(p, f"全书大纲第{book['version']}版已生效，{len(affected)}章需要按新走向复核。")
    elif action == "restore_book_outline":
        old = next((x for x in book["history"] if x["version"] == data.get("version")), None)
        if not old:
            raise novel.StoryError("大纲历史版本不存在。")
        import proposals
        proposals.checkpoint_outline(book, "恢复生效旧版前的大纲草稿")
        book["draft"] = copy.deepcopy(old["outline"])
    else:
        raise novel.StoryError("未知全书大纲操作。")


def save_proposal(p, result):
    # Compatibility helper: callers must explicitly adopt this returned preview.
    import proposals
    return proposals.outline_preview(p, result)


def completed_before(p, c):
    done = {}
    for previous in p["chapters"]:
        if previous["id"] == c["id"]:
            break
        if previous["status"] == "approved" and previous.get("completes_node") and previous.get("node_id"):
            done[previous["node_id"]] = {"chapter_id": previous["id"], "chapter": previous["title"], "evidence": previous["node_evidence"]}
    return done


def require_ready(p, c):
    book = ensure(p)
    if not book["active"]:
        raise novel.StoryError("请先在「全书大纲」填写并确认故事走向，再生成章节。")
    nodes = book["active"]["nodes"]
    index = next((i for i, node in enumerate(nodes) if node["id"] == c["node_id"]), None)
    if index is None:
        raise novel.StoryError("请先在本章「场景方案」选择一个生效大纲节点；原绑定节点可能已被更换。")
    for previous in p["chapters"]:
        if previous["id"] == c["id"]:
            break
        if previous["status"] != "approved":
            raise novel.StoryError(f"请先确认前章《{previous['title']}》，再沿大纲推进本章。")
    done = completed_before(p, c)
    if c["node_id"] in done:
        raise novel.StoryError("前面的章节已完成这个阶段节点，请选择下一个节点，或先调整前章的完成标记。")
    for node in nodes[:index]:
        if node["id"] not in done:
            raise novel.StoryError(f"不能跳过尚未完成的节点「{node['title']}」。请先完成并确认相应章节。")
    return nodes[index]


def validate_approval(p, c, checked):
    book = ensure(p)
    # Keep legacy manual manuscripts usable; all AI chapter generation is gated unconditionally.
    if not book["active"]:
        return
    require_ready(p, c)
    if checked is not True:
        raise novel.StoryError("请先勾选已核对本章与当前全书大纲一致，再确认正文。")
    if c["completes_node"] and (not c["node_evidence"].strip() or c["node_evidence"] not in c["text"]):
        raise novel.StoryError("标记阶段完成时，需要填写当前正文中逐字一致的完成依据。")
    c["outline_checked_version"] = book["version"]


def context(p, c):
    book = ensure(p)
    if not book["active"]:
        return None
    active = book["active"]
    index = next((i for i, node in enumerate(active["nodes"]) if node["id"] == c["node_id"]), None)
    return {"version": book["version"], "author_outline": active["text"], "required_ending": active["ending"],
            "non_negotiables": active["guardrails"], "milestones": active["nodes"],
            "current_milestone": active["nodes"][index] if index is not None else None,
            "future_milestones_not_yet_happened": active["nodes"][index + 1:] if index is not None else active["nodes"],
            "completed_milestones_before_this_chapter": completed_before(p, c),
            "this_chapter_should_complete_milestone": c["completes_node"],
            "rule": "全书大纲是作者意图而非已发生事实。只推进当前节点，不改结局、不跳过必经事件、不提前兑现未来节点；完成节点时仍须正文证据与作者确认。"}
