"""Story domain: explicit approval, evidence, ordered canon, and revision history."""
import copy
import datetime as dt
import uuid
import outline as story_outline


class StoryError(ValueError):
    pass


def uid():
    return uuid.uuid4().hex[:12]


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


FIELDS = {
    "character": {"appearance": "外貌与衣着", "location": "位置", "condition": "身体与情绪", "goal": "当前目标",
                  "knowledge": "已知信息", "beliefs": "误解与猜测", "relationships": "人物关系", "inventory": "持有物品"},
    "world": {"fact": "客观事实", "reader": "读者已知信息"},
    "thread": {"status": "伏笔状态", "detail": "伏笔内容", "payoff": "回收计划"},
}
STYLE_FIELDS = ("perspective", "rhythm", "dialogue", "description", "avoid")


def upgrade(p):
    """Add optional fields without changing existing prose or approval state."""
    p.setdefault("references", [])
    p.setdefault("style_reference_mode", "samples" if p["style"].get("sample", "").strip() else "card")
    for entity in p["entities"]:
        if entity["kind"] == "character":
            entity["base"].setdefault("appearance", "")
    story_outline.ensure(p)
    return p


def chapter(title="新的章节"):
    return {"id": uid(), "title": title, "intent": "", "outline": "", "text": "", "summary": "",
            "node_id": "", "completes_node": False, "node_evidence": "", "outline_checked_version": 0,
            "cast": [], "status": "draft", "accepted_text": "", "accepted_summary": "", "changes": [],
            "review": None, "versions": [], "updated_at": now()}


def new_project(title="未命名小说"):
    return {"id": uid(), "revision": 0, "title": title, "is_demo": False, "created_at": now(), "updated_at": now(),
            "brief": {"premise": "", "genre": "", "audience": "", "conflict": "", "ending": "", "target": "50000"},
            "style": {"perspective": "第三人称限知视角", "rhythm": "长短句交替，冲突处收紧节奏", "dialogue": "用行动和潜台词表现关系",
                      "description": "描写服务于人物感受与情节", "avoid": "避免套话、重复解释和无意义的感叹", "sample": ""},
            "style_reference_mode": "card", "references": [], "book_outline": story_outline.empty(),
            "entities": [], "chapters": [chapter("第一章")], "events": []}


def demo_project():
    p = new_project("雾港来信")
    p["is_demo"] = True
    p["brief"].update(genre="悬疑 · 人物成长", audience="喜欢克制叙事与悬念的成年读者", premise="停航七年的雾港，每逢潮汐都会收到一封来自失踪者的信。修船匠林照收到父亲的笔迹，却发现信纸是明天才会出厂的。", conflict="林照想找到父亲，港务员沈砚却必须在退潮前销毁所有来信。", ending="林照揭开来信的机制，也必须决定是否公开父亲参与的旧案。")
    p["style"].update(sample="潮水退下去，露出码头石阶上的一道白痕。林照把信折回原样。信封没有湿，送信人的袖口却还在滴水。")
    a, b, w, f = uid(), uid(), uid(), uid()
    p["entities"] = [
        {"id": a, "kind": "character", "name": "林照", "description": "27岁，修船匠。想找到失踪的父亲；害怕自己继承了他的怯懦。底线：不拿无辜者换答案。说话简短，紧张时会纠正细节。", "locked": False,
         "base": {"location": "旧船厂", "condition": "右手旧伤，潮湿时疼痛", "goal": "查明父亲失踪的原因", "knowledge": "父亲七年前在封港当夜失踪", "beliefs": "认为父亲遭遇海难", "relationships": "与沈砚是旧识，对他的港务员身份心存戒备", "inventory": "父亲留下的黄铜罗盘"}},
        {"id": b, "kind": "character", "name": "沈砚", "description": "31岁，港务员。想保护妹妹免受旧案牵连；对秩序的依赖掩盖了愧疚。习惯用反问回避私人问题。", "locked": False,
         "base": {"location": "港务所", "condition": "连续值夜，疲惫", "goal": "回收本次潮汐送来的信", "knowledge": "知道信件与封港旧案有关", "beliefs": "认为隐瞒能保护林照", "relationships": "与林照是旧识，隐瞒了封港当晚的见闻", "inventory": "港务所钥匙、回收名单"}},
        {"id": w, "kind": "world", "name": "雾港与封航", "description": "故事的空间与规则。", "locked": True,
         "base": {"fact": "雾港七年前封航。外海航道尚未恢复；进出港须持港务所通行证。", "reader": "雾港已停航七年"}},
        {"id": f, "kind": "thread", "name": "没有湿的信封", "description": "第一章埋下的物理异常。", "locked": False,
         "base": {"status": "已埋设", "detail": "送信人的袖口滴水，信封却完全干燥。", "payoff": "中段揭示信件并非由海上运来；回收前不提前解释机制。"}},
    ]
    c = p["chapters"][0]
    c.update(title="第一章 · 退潮后的信", intent="让林照收到父亲来信，用一个小异常建立悬念。", outline="旧船厂等潮 → 陌生人送信 → 林照辨认笔迹 → 决定去港务所", cast=[a],
             text="潮水退下去，露出码头石阶上的一道白痕。\n\n林照停下刨子。门外的人已经站了很久，袖口的水滴在门槛上，积出一小片深色。\n\n“林师傅？”\n\n“修船要等明天。”\n\n那人没有进门，只把一封信放在窗台。纸角压着一颗生锈的螺帽。林照先看见收信人的名字，再看见那个被拖得很长的照字——父亲总说，这一笔像船尾的缆绳。\n\n他追到门口。石阶上没有人，只有水声。\n\n信封是干的。连胶口都没有受潮。\n\n林照用刨刀挑开封口。里面只有一行字：别让港务所的人看见。\n\n他把信折回原样，收进内袋。父亲已经失踪七年，而他忽然记不起，最后一次听见父亲叫自己的名字，是在岸上，还是船上。\n\n傍晚，他关上船厂的门，向港务所走去。",
             summary="林照在退潮后收到疑似父亲笔迹的来信。信封异常干燥，信中要求避开港务所。他仍决定前往港务所调查。")
    c["changes"] = [
        {"id": uid(), "entity_id": a, "field": "inventory", "value": "父亲留下的黄铜罗盘；疑似父亲寄来的信", "evidence": "他把信折回原样，收进内袋。", "selected": True},
        {"id": uid(), "entity_id": a, "field": "goal", "value": "前往港务所，调查疑似父亲的来信", "evidence": "傍晚，他关上船厂的门，向港务所走去。", "selected": True},
    ]
    approve(p, c["id"])
    c2 = chapter("第二章 · 值夜人")
    c2.update(intent="让林照试探沈砚；沈砚试图回收信件，却暴露自己早知道来信的存在。以一条新的线索收尾。", outline="1. 港务所门外，林照观察夜班名单。\n2. 沈砚主动询问信封，暴露信息差。\n3. 林照隐瞒信的内容，以旧船厂的维修单试探。\n4. 沈砚要求他在退潮前离开，林照发现名单上的父亲姓名。", cast=[a, b])
    p["chapters"].append(c2)
    p["events"] = []
    return p


def get_chapter(p, cid):
    for c in p["chapters"]:
        if c["id"] == cid:
            return c
    raise StoryError("章节不存在。")


def canon(p, before=None):
    result = {e["id"]: {**copy.deepcopy(e), "state": copy.deepcopy(e["base"]), "sources": {}} for e in p["entities"]}
    for c in p["chapters"]:
        if c["id"] == before:
            break
        if c["status"] != "approved":
            continue
        for change in c.get("accepted_changes", []):
            e = result.get(change["entity_id"])
            if e:
                e["state"][change["field"]] = change["value"]
                e["sources"][change["field"]] = {"chapter_id": c["id"], "title": c["title"], "evidence": change["evidence"]}
    return list(result.values())


def snapshot(c, reason):
    c["versions"].append({"id": uid(), "at": now(), "reason": reason, "text": c["text"], "title": c["title"], "summary": c["summary"], "outline": c["outline"]})
    c["versions"] = c["versions"][-100:]


def invalidate(p, cid, include_self=False):
    index = next(i for i, c in enumerate(p["chapters"]) if c["id"] == cid)
    affected = []
    for c in p["chapters"][index + (0 if include_self else 1):]:
        if c["status"] == "approved":
            c["status"] = "needs_review"
            affected.append(c["title"])
    return affected


def log(p, message):
    p["events"].insert(0, {"at": now(), "message": message})
    p["events"] = p["events"][:100]


def validate_changes(p, c):
    entities = {e["id"]: e for e in p["entities"]}
    selected = []
    seen = set()
    for item in c["changes"]:
        if not item.get("selected"):
            continue
        e = entities.get(item.get("entity_id"))
        if not e or item.get("field") not in FIELDS[e["kind"]]:
            raise StoryError("状态变化指向了不存在的人物、设定或字段。")
        if e["locked"]:
            raise StoryError(f"「{e['name']}」已锁定，请取消该变化或先在档案中解锁。")
        evidence = item.get("evidence", "").strip()
        if not evidence or evidence not in c["text"]:
            raise StoryError(f"「{e['name']}」的原文依据不在当前正文中，请重新核对。")
        if not isinstance(item.get("value"), str) or not item["value"].strip():
            raise StoryError("状态变化的内容不能为空。")
        key = (e["id"], item["field"])
        if key in seen:
            raise StoryError("同一章节中，同一状态字段只能确认一个最终值。")
        seen.add(key)
        selected.append(copy.deepcopy(item))
    return selected


def approve(p, cid, outline_checked=False):
    c = get_chapter(p, cid)
    for previous in p["chapters"]:
        if previous["id"] == cid:
            break
        if previous["status"] != "approved":
            raise StoryError("请先按顺序确认前面的章节，再确认本章。")
    if not c["text"].strip():
        raise StoryError("请先写入正文。")
    if not c["summary"].strip():
        raise StoryError("请先填写章节摘要，供后续章节检索。")
    story_outline.validate_approval(p, c, outline_checked)
    selected = validate_changes(p, c)
    changed = c.get("accepted_text") != c["text"] or c.get("accepted_changes", []) != selected or c.get("accepted_summary") != c["summary"]
    affected = invalidate(p, cid) if changed else []
    snapshot(c, "作者确认正文")
    c.update(status="approved", accepted_text=c["text"], accepted_summary=c["summary"], accepted_changes=selected, updated_at=now())
    log(p, f"已确认《{c['title']}》，入库 {len(selected)} 项变化。" + (f"后续 {len(affected)} 章待复核。" if affected else ""))


def bounded_string(value, limit=50000):
    if not isinstance(value, str) or len(value) > limit:
        raise StoryError(f"文本格式无效或超过 {limit} 字符。")
    return value


def normalize_changes(items):
    if not isinstance(items, list) or len(items) > 100:
        raise StoryError("状态变化必须是列表且不超过100项。")
    result = []
    for item in items:
        if not isinstance(item, dict):
            raise StoryError("状态变化格式不正确。")
        result.append({"id": bounded_string(item.get("id") or uid(), 100), "entity_id": bounded_string(item.get("entity_id", ""), 100),
                       "field": bounded_string(item.get("field", ""), 100), "value": bounded_string(item.get("value", ""), 5000),
                       "evidence": bounded_string(item.get("evidence", ""), 5000), "selected": item.get("selected") is True})
    return result


def mutate(p, action, data):
    upgrade(p)
    if action in ("save_book_outline", "publish_book_outline", "restore_book_outline"):
        story_outline.mutate(p, action, data)
    elif action == "save_story":
        title = bounded_string(data.get("title", p["title"]), 200).strip()
        if not title:
            raise StoryError("书名不能为空。")
        p["title"] = title
        for section in ("brief", "style"):
            for key in p[section]:
                if key in data.get(section, {}):
                    p[section][key] = bounded_string(data[section][key], 10000)
        target = p["brief"]["target"].strip()
        if not target.isascii() or not target.isdigit() or not 1 <= int(target) <= 10000000:
            raise StoryError("目标字数须为1至10000000之间的整数。")
        log(p, "已更新故事方向与文风卡。")
    elif action == "save_entity":
        kind = data.get("kind")
        if kind not in FIELDS:
            raise StoryError("档案类型无效。")
        name = bounded_string(data.get("name", ""), 100).strip()
        if not name:
            raise StoryError("名称不能为空。")
        base = {key: bounded_string(data.get("base", {}).get(key, ""), 5000) for key in FIELDS[kind]}
        old = next((e for e in p["entities"] if e["id"] == data.get("id")), None)
        e = {"id": old["id"] if old else uid(), "kind": kind, "name": name, "description": bounded_string(data.get("description", ""), 10000), "base": base, "locked": data.get("locked") is True}
        if old and "reference_ids" in old:
            e["reference_ids"] = old["reference_ids"][:]
        if old:
            if old["kind"] != kind:
                raise StoryError("已有档案不能更改类型。")
            if any(old[k] != e[k] for k in ("base", "description", "name")):
                invalidate(p, p["chapters"][0]["id"], True)
                log(p, f"已修改「{name}」的基础档案，已确认章节需要重新复核。")
            p["entities"][p["entities"].index(old)] = e
        else:
            p["entities"].append(e)
    elif action == "add_chapter":
        p["chapters"].append(chapter(bounded_string(data.get("title", f"第{len(p['chapters']) + 1}章"), 200)))
    elif action == "save_chapter":
        c = get_chapter(p, data.get("id"))
        updates = {k: bounded_string(data.get(k, c[k]), 100000 if k == "text" else 10000) for k in ("title", "intent", "outline", "text", "summary")}
        changes = normalize_changes(data.get("changes", c["changes"]))
        cast = data.get("cast", c["cast"])
        allowed_cast = {e["id"] for e in p["entities"] if e["kind"] == "character"}
        if not isinstance(cast, list) or any(x not in allowed_cast for x in cast):
            raise StoryError("出场人物无效。")
        mapping = {"node_id": bounded_string(data.get("node_id", c["node_id"]), 100),
                   "completes_node": data.get("completes_node", c["completes_node"]) is True,
                   "node_evidence": bounded_string(data.get("node_evidence", c["node_evidence"]), 5000)}
        mapping_changed = any(mapping[k] != c[k] for k in mapping)
        substantive = any(updates[k] != c[k] for k in ("text", "summary")) or changes != c["changes"] or mapping_changed
        if updates["text"] != c["text"]:
            snapshot(c, "编辑前的版本")
            c["review"] = None
        if mapping_changed:
            c["review"] = None
            c["outline_checked_version"] = 0
        if substantive and c["status"] == "approved":
            affected = invalidate(p, c["id"], True)
            log(p, f"正文或状态变化已修改，{len(affected)} 章等待复核。")
        c.update(updates, **mapping, changes=changes, cast=cast, updated_at=now())
    elif action == "approve":
        approve(p, data.get("id"), data.get("outline_checked") is True)
    elif action == "restore":
        c = get_chapter(p, data.get("id"))
        version = next((v for v in c["versions"] if v["id"] == data.get("version_id")), None)
        if not version:
            raise StoryError("版本不存在。")
        snapshot(c, "恢复前的版本")
        invalidate(p, c["id"], True)
        c.update({key: version[key] for key in ("text", "title", "summary", "outline")})
        c.update(status="needs_review" if c["accepted_text"] else "draft", review=None, changes=[])
        log(p, f"《{c['title']}》已恢复为待确认草稿。")
    elif action == "preflight":
        c = get_chapter(p, data.get("id"))
        c["review"] = preflight(p, c)
    elif action == "save_style_reference":
        ref = get_reference(p, data["id"], "style") if data.get("id") else None
        title = bounded_string(data.get("title", ""), 200).strip()
        text = bounded_string(data.get("text", ""), 30000).strip()
        notes = bounded_string(data.get("notes", ""), 3000)
        if not title or not text:
            raise StoryError("请填写参考名称和原文。")
        if ref:
            if ref["text"] != text or ref["notes"] != notes:
                ref.update(analysis=None, active=False)
            ref.update(title=title, text=text, notes=notes)
        else:
            if len(p["references"]) >= 40:
                raise StoryError("单部作品最多保存40份参考材料。")
            p["references"].append({"id": uid(), "kind": "style", "title": title, "text": text, "notes": notes,
                                    "active": False, "analysis": None, "created_at": now()})
    elif action == "set_reference_mode":
        mode = data.get("mode")
        if mode not in ("card", "samples"):
            raise StoryError("文风参考模式无效。")
        p["style_reference_mode"] = mode
    elif action == "toggle_style_reference":
        ref = get_reference(p, data.get("id"), "style")
        if data.get("active") is True:
            active = [r for r in p["references"] if r["kind"] == "style" and r.get("active") and r["id"] != ref["id"]]
            if len(active) >= 3:
                raise StoryError("同时最多启用3份文风样例，请先停用一份。")
        ref["active"] = data.get("active") is True
    elif action == "apply_style_analysis":
        ref = get_reference(p, data.get("id"), "style")
        if not ref.get("analysis"):
            raise StoryError("请先分析参考文本。")
        fields = data.get("fields", [])
        if not isinstance(fields, list) or not fields or any(key not in STYLE_FIELDS for key in fields):
            raise StoryError("请至少选择一个有效的文风维度。")
        values = data.get("values", {})
        for key in fields:
            p["style"][key] = bounded_string(values.get(key, ""), 10000)
        ref["applied_at"] = now()
        log(p, f"已将「{ref['title']}」的分析应用到 {len(fields)} 个文风维度。")
    elif action == "apply_character_reference":
        ref = get_reference(p, data.get("id"), "character")
        if not ref.get("analysis"):
            raise StoryError("请先分析人物参考图。")
        target_id = data.get("entity_id")
        old = next((e for e in p["entities"] if e["id"] == target_id and e["kind"] == "character"), None)
        if target_id and not old:
            raise StoryError("目标人物不存在。")
        if old and old["locked"]:
            raise StoryError("目标人物已锁定，请先在人物档案中解锁。")
        fields = data.get("fields", [])
        allowed = set(FIELDS["character"]) | {"description"}
        if not isinstance(fields, list) or not fields or any(key not in allowed for key in fields):
            raise StoryError("请至少选择一项需要采用的人物设定。")
        values = data.get("values", {})
        clean = {key: bounded_string(values.get(key, ""), 5000) for key in fields}
        entity = copy.deepcopy(old) if old else {"kind": "character", "name": bounded_string(data.get("name", ""), 100), "description": "", "base": {}, "locked": False}
        for key, value in clean.items():
            if key == "description":
                entity["description"] = value
            else:
                entity["base"][key] = value
        mutate(p, "save_entity", entity)
        saved = next(e for e in p["entities"] if e["id"] == old["id"]) if old else p["entities"][-1]
        saved.setdefault("reference_ids", [])
        if ref["id"] not in saved["reference_ids"]:
            saved["reference_ids"].append(ref["id"])
        ref.update(entity_id=saved["id"], applied_at=now())
        log(p, f"已采用「{ref['title']}」中的 {len(fields)} 项设定，用于人物「{saved['name']}」。")
    else:
        raise StoryError("未知操作。")


def preflight(p, c):
    issues = []
    def issue(kind, message, quote="", severity="提醒"):
        issues.append({"kind": kind, "message": message, "quote": quote, "severity": severity, "suggestion": ""})
    if not c["text"].strip():
        issue("正文", "本章还没有正文。", severity="问题")
    if not c["summary"].strip():
        issue("记忆", "补充章节摘要后才能确认入库。", severity="问题")
    if not c["intent"].strip():
        issue("场景", "建议明确本章目标、阻碍、选择与后果。")
    try:
        story_outline.require_ready(p, c)
        if c["completes_node"] and (not c["node_evidence"].strip() or c["node_evidence"] not in c["text"]):
            issue("大纲", "阶段完成标记缺少有效的正文依据。", severity="问题")
    except StoryError as exc:
        issue("大纲", str(exc), severity="问题")
    try:
        validate_changes(p, c)
    except StoryError as exc:
        issue("状态", str(exc), severity="问题")
    paragraphs = [s.strip() for s in c["text"].splitlines() if len(s.strip()) >= 30]
    seen = set()
    for para in paragraphs:
        if para in seen:
            issue("重复", "存在完全重复的段落。", para)
        seen.add(para)
    for earlier in p["chapters"]:
        if earlier["id"] == c["id"]:
            break
        if earlier["status"] != "approved":
            issue("上下文", f"《{earlier['title']}》尚未确认，不能作为正式记忆。")
    return {"source": "local", "at": now(), "overview": "规则预检只检查可确定的问题，不代表剧情、人物动机或文风已通过审稿。", "issues": issues}


def build_context(p, c):
    upgrade(p)
    previous = []
    for item in p["chapters"]:
        if item["id"] == c["id"]:
            break
        if item["status"] == "approved":
            previous.append(item)
    cast = set(c["cast"])
    states = canon(p, before=c["id"])
    entities = [{k: e[k] for k in ("id", "kind", "name", "description", "locked", "state", "sources")}
                for e in states if e["kind"] != "character" or not cast or e["id"] in cast]
    style = copy.deepcopy(p["style"])
    samples = []
    if p["style_reference_mode"] == "card":
        style.pop("sample", None)
    else:
        samples = [{"title": r["title"], "focus": r["notes"], "excerpt": r["text"][:4000], "truncated": len(r["text"]) > 4000}
                   for r in p["references"] if r["kind"] == "style" and r.get("active")][:3]
    brief = copy.deepcopy(p["brief"])
    if p["book_outline"]["active"]:
        brief["ending"] = p["book_outline"]["active"]["ending"]
    return {"book": p["title"], "brief": brief, "whole_book_direction": story_outline.context(p, c), "style": style, "style_samples": samples, "entities": entities,
            "previous_chapters": [{"title": x["title"], "summary": x["accepted_summary"]} for x in previous],
            "recent_prose": [{"title": x["title"], "text": x["accepted_text"][-6000:]} for x in previous[-2:]],
            "chapter": {k: c[k] for k in ("title", "intent", "outline", "text", "summary")},
            "fields": FIELDS}


def get_reference(p, rid, kind=None):
    for ref in p.get("references", []):
        if ref["id"] == rid and (kind is None or ref["kind"] == kind):
            return ref
    raise StoryError("参考材料不存在或类型不匹配。")


def add_image_reference(p, ref):
    upgrade(p)
    if len(p["references"]) >= 40 or sum(r["kind"] == "character" for r in p["references"]) >= 12:
        raise StoryError("单部作品最多保存40份材料，其中人物参考图最多12张。")
    if ref.get("entity_id") and not any(e["id"] == ref["entity_id"] and e["kind"] == "character" for e in p["entities"]):
        raise StoryError("关联人物不存在。")
    p["references"].append(ref)


def reference_feedback(ref, feedback):
    if feedback is None:
        return None
    feedback = bounded_string(feedback, 5000).strip()
    if not feedback:
        raise StoryError("请先指出读图结果哪里不准确，以及希望怎样修正。")
    if ref["kind"] != "character" or not ref.get("analysis"):
        raise StoryError("请先完成一次人物读图分析，再提出修正意见。")
    return feedback


def reference_context(p, ref, feedback=None):
    feedback = reference_feedback(ref, feedback)
    if ref["kind"] == "style":
        return {"reference_kind": "style", "reference": {key: ref[key] for key in ("title", "text", "notes")}, "style_fields": list(STYLE_FIELDS)}
    existing = next((e for e in p["entities"] if e["id"] == ref.get("entity_id")), None)
    context = {"reference_kind": "character", "reference_title": ref["title"], "author_notes": ref["notes"],
            "genre": p["brief"]["genre"], "premise": p["brief"]["premise"], "existing_character": existing, "fields": FIELDS["character"]}
    if feedback is not None:
        # A full re-analysis starts a fresh correction chain, while old analyses remain available for review.
        previous = [entry["analysis"] for entry in ref.get("analysis_history", [])] + [ref["analysis"]]
        history = []
        for analysis in reversed(previous):
            if not analysis.get("feedback"):
                break
            history.append(analysis["feedback"])
        context["reference_correction"] = {"previous_analysis": copy.deepcopy(ref["analysis"]), "feedback_history": list(reversed(history))}
    return context


def save_reference_analysis(p, rid, result, feedback=None):
    ref = get_reference(p, rid)
    feedback = reference_feedback(ref, feedback)
    if not isinstance(result, dict):
        raise StoryError("模型没有返回有效的分析对象，原有设定已保留。")
    if ref["kind"] == "style":
        style = result.get("style")
        if not isinstance(style, dict) or not all(isinstance(style.get(k), str) and style[k].strip() for k in STYLE_FIELDS):
            raise StoryError("文风分析缺少必要维度，请重试；现有文风卡没有改变。")
        evidence = result.get("evidence", [])
        if not isinstance(evidence, list) or len(evidence) > 20:
            raise StoryError("文风分析的原文依据格式不正确。")
        clean_evidence = []
        for item in evidence:
            if not isinstance(item, dict):
                raise StoryError("文风分析的原文依据格式不正确。")
            quote = bounded_string(item.get("quote", ""), 1000)
            clean_evidence.append({"quote": quote, "observation": bounded_string(item.get("observation", ""), 3000), "verified": bool(quote.strip() and quote in ref["text"])})
        analysis = {"overview": bounded_string(result.get("overview", ""), 5000), "style": {k: bounded_string(style[k], 5000) for k in STYLE_FIELDS}, "evidence": clean_evidence}
    else:
        observations, character = result.get("observations"), result.get("character")
        if not isinstance(observations, dict) or not isinstance(character, dict):
            raise StoryError("读图结果格式不正确，请重试；人物档案没有改变。")
        visible = {key: bounded_string(observations.get(key, ""), 5000) for key in ("appearance", "clothing", "posture", "expression")}
        if not any(value.strip() for value in visible.values()):
            raise StoryError("模型没有提供可见特征，请使用清晰的人物图及支持读图的模型。")
        base = character.get("base", {})
        if not isinstance(base, dict):
            raise StoryError("人物设定建议格式不正确。")
        uncertainties = result.get("uncertainties", [])
        if not isinstance(uncertainties, list) or len(uncertainties) > 20:
            raise StoryError("读图不确定项格式不正确。")
        analysis = {"observations": visible, "uncertainties": [bounded_string(x, 1000) for x in uncertainties],
                    "character": {"name": bounded_string(character.get("name", "未命名人物"), 100), "description": bounded_string(character.get("description", ""), 5000),
                                  "base": {key: bounded_string(base.get(key, ""), 5000) for key in FIELDS["character"]}}}
        # Appearance is grounded in the explicitly separated observations, not invented biography.
        analysis["character"]["base"]["appearance"] = "\n".join(f"{label}：{visible[key]}" for key, label in (("appearance", "外貌"), ("clothing", "衣着"), ("posture", "姿态"), ("expression", "表情")) if visible[key])
    analysis["at"] = now()
    if ref["kind"] == "character":
        if feedback is not None:
            analysis["feedback"] = feedback
        if ref.get("analysis"):
            history = list(ref.get("analysis_history", []))
            history.append({"analysis": copy.deepcopy(ref["analysis"]), "replaced_at": analysis["at"]})
            ref["analysis_history"] = history[-10:]
    ref["analysis"] = analysis
    log(p, f"「{ref['title']}」{'按反馈修正' if feedback is not None else '分析'}完成，等待作者选择采用。")


def apply_ai(p, cid, action, result):
    c = get_chapter(p, cid)
    if not isinstance(result, dict):
        raise StoryError("模型返回的内容不是有效对象，原稿已保留。")
    if action == "plan":
        outline = bounded_string(result.get("outline", ""), 10000)
        if not outline.strip():
            raise StoryError("模型没有返回场景方案，原稿已保留。")
        c["outline"] = outline
    elif action in ("draft", "rewrite"):
        text = bounded_string(result.get("text", ""), 100000)
        summary = bounded_string(result.get("summary", ""), 10000)
        if not text.strip() or not summary.strip():
            raise StoryError("模型没有返回正文或摘要，原稿已保留。")
        changes = normalize_changes(result.get("changes", []))
        for item in changes:
            item["selected"] = False
        snapshot(c, "AI改写前的版本" if action == "rewrite" else "AI起草前的版本")
        invalidate(p, cid, True)
        c.update(text=text, summary=summary, changes=changes, review=None, status="needs_review" if c["accepted_text"] else "draft")
    elif action == "review":
        overview = bounded_string(result.get("overview", ""), 10000)
        issues = result.get("issues", [])
        if not overview or not isinstance(issues, list) or len(issues) > 100:
            raise StoryError("模型的审稿格式不正确，原稿已保留。")
        clean = []
        for issue in issues:
            if not isinstance(issue, dict):
                raise StoryError("审稿意见格式不正确。")
            clean.append({key: bounded_string(issue.get(key, ""), 10000) for key in ("severity", "kind", "quote", "message", "suggestion")})
        c["review"] = {"source": "ai", "at": now(), "overview": overview, "issues": clean}
    else:
        raise StoryError("未知模型操作。")
    c["updated_at"] = now()
    log(p, f"《{c['title']}》已完成" + {"plan": "场景规划", "draft": "AI起草", "rewrite": "定向修订", "review": "AI审稿"}[action] + "，等待作者确认。")


def markdown(p):
    parts = [f"# {p['title']}", "> 导出当前工作稿。待复核章节与未确认草稿均有标记。"]
    for c in p["chapters"]:
        label = {"approved": "已确认", "draft": "草稿", "needs_review": "待复核"}[c["status"]]
        parts += [f"## {c['title']}", f"> {label}", c["text"] or "（尚无正文）"]
    return "\n\n".join(parts) + "\n"
