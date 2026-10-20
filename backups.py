"""Validate portable backups before an atomic restore into a separate project."""
import copy
import re
import novel
import outline


FORMAT = "story-workbench-v2"
MAX_BYTES = 80_000_000


def fail():
    raise novel.StoryError("备份内容不完整或格式无效，请选择本应用导出的作品 JSON 备份。")


def obj(value):
    if not isinstance(value, dict):
        fail()
    return value


def items(value, limit=20000):
    if not isinstance(value, list) or len(value) > limit:
        fail()
    return value


def text(value, limit=100000):
    return novel.bounded_string(value, limit)


def boolean(value):
    if type(value) is not bool:
        fail()


def identifier(value):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", text(value, 100)):
        fail()
    return value


def unique(rows):
    seen = set()
    for row in rows:
        value = identifier(obj(row).get("id"))
        if value in seen:
            fail()
        seen.add(value)
    return seen


def tree(value, depth=0, budget=None):
    # Bound unknown optional metadata too; never interpret strings as commands.
    budget = budget if budget is not None else [500000]
    budget[0] -= 1
    if depth > 40 or budget[0] < 0:
        fail()
    if isinstance(value, dict):
        for key, child in value.items():
            text(key, 100)
            tree(child, depth + 1, budget)
    elif isinstance(value, list):
        for child in items(value):
            tree(child, depth + 1, budget)
    elif isinstance(value, str):
        text(value)
    elif value is not None and type(value) not in (int, bool):
        fail()


def review(value):
    if value is None:
        return
    obj(value)
    if value.get("source") not in ("ai", "local"):
        fail()
    for key in ("at", "overview"):
        text(value.get(key), 10000)
    for issue in items(value.get("issues"), 100):
        for key in ("severity", "kind", "quote", "message", "suggestion"):
            text(obj(issue).get(key), 10000)
    if "stale" in value:
        boolean(value["stale"])
    for key in ("stale_reason", "stale_at", "source_hash"):
        if key in value:
            text(value[key], 10000)
    if "source_revision" in value and type(value["source_revision"]) is not int:
        fail()


def changes(rows, entities):
    rows = items(rows, 100)
    unique(rows)
    for change in rows:
        entity = entities.get(change.get("entity_id"))
        if not entity or change.get("field") not in novel.FIELDS[entity["kind"]]:
            fail()
        for key in ("value", "evidence"):
            text(change.get(key), 5000)
        boolean(change.get("selected"))


def mapping(value):
    for key, limit in (("node_id", 100), ("node_evidence", 5000)):
        if key in value:
            text(value[key], limit)
    if value.get("node_id"):
        identifier(value["node_id"])
    for key in ("completes_node", "local_edit_review_required"):
        if key in value:
            boolean(value[key])
    if "outline_checked_version" in value and type(value["outline_checked_version"]) is not int:
        fail()


def analysis(value, kind):
    if value is None:
        return
    obj(value)
    for key in ("at", "feedback"):
        if key in value:
            text(value[key], 5000)
    if kind == "style":
        text(value.get("overview"), 10000)
        for key in novel.STYLE_FIELDS:
            text(obj(value.get("style")).get(key), 10000)
        for evidence in items(value.get("evidence"), 100):
            text(obj(evidence).get("quote"), 10000)
            text(evidence.get("observation"), 10000)
            boolean(evidence.get("verified"))
    else:
        for key in ("appearance", "clothing", "posture", "expression"):
            text(obj(value.get("observations")).get(key), 5000)
        for uncertainty in items(value.get("uncertainties"), 20):
            text(uncertainty, 2000)
        character = obj(value.get("character"))
        text(character.get("name"), 100)
        text(character.get("description"), 5000)
        for key, content in obj(character.get("base")).items():
            if key not in novel.FIELDS["character"]:
                fail()
            text(content, 5000)


def direction(value, *, active=False):
    value = obj(value)
    if not {"text", "ending", "guardrails", "nodes"} <= value.keys():
        fail()
    unique(items(value["nodes"], 30))
    for node in value["nodes"]:
        if not {"id", "title", "goal", "must", "avoid", "source_quote"} <= obj(node).keys():
            fail()
    outline.clean_draft(value, require_nodes=active)


def validate_project(p):
    obj(p)
    tree(p)
    required = set(novel.new_project()) - {"references", "style_reference_mode", "book_outline"}
    if not required <= p.keys() or p.keys() - set(novel.new_project()):
        fail()
    identifier(p["id"])
    if type(p["revision"]) is not int or p["revision"] < 0 or not text(p["title"], 200).strip():
        fail()
    boolean(p["is_demo"])
    for key in ("created_at", "updated_at"):
        text(p[key], 100)
    for section in ("brief", "style"):
        default = novel.new_project()[section]
        if not default.keys() <= obj(p[section]).keys():
            fail()
        for content in p[section].values():
            text(content, 10000)
    target = p["brief"]["target"]
    if not target.isascii() or not target.isdigit() or not 1 <= int(target) <= 10000000:
        fail()
    entities = items(p["entities"])
    entity_ids = unique(entities)
    entity_map = {entity["id"]: entity for entity in entities}
    for entity in entities:
        kind = entity.get("kind")
        if kind not in novel.FIELDS or not text(entity.get("name"), 100).strip():
            fail()
        text(entity.get("description"), 10000)
        boolean(entity.get("locked"))
        for key, content in obj(entity.get("base")).items():
            if key not in novel.FIELDS[kind]:
                fail()
            text(content, 5000)
    chapters = items(p["chapters"])
    if not chapters:
        fail()
    unique(chapters)
    for chapter in chapters:
        if "review" not in chapter:
            fail()
        for key in ("title", "intent", "outline", "text", "summary", "accepted_text", "accepted_summary", "updated_at"):
            text(chapter.get(key), 100000 if key in ("text", "accepted_text") else 10000)
        if chapter.get("status") not in ("draft", "approved", "needs_review"):
            fail()
        if any(identifier(cid) not in entity_ids or entity_map[cid]["kind"] != "character" for cid in items(chapter.get("cast"))):
            fail()
        changes(chapter.get("changes"), entity_map)
        changes(chapter.get("accepted_changes", []), entity_map)
        review(chapter.get("review"))
        versions = items(chapter.get("versions"), 1000)
        unique(versions)
        for version in versions:
            for key in ("at", "reason", "title", "summary", "outline", "text"):
                text(version.get(key), 100000 if key == "text" else 10000)
            for key in ("changes", "accepted_changes"):
                if key in version:
                    changes(version[key], entity_map)
            for key in ("accepted_text", "accepted_summary", "intent"):
                if key in version:
                    text(version[key], 100000 if key == "accepted_text" else 10000)
            if "cast" in version and any(identifier(cid) not in entity_ids for cid in items(version["cast"])):
                fail()
            if "kind" in version and version["kind"] not in ("edit", "checkpoint"):
                fail()
            mapping(version)
    for event in items(p["events"], 100):
        text(obj(event).get("at"), 100)
        text(event.get("message"), 10000)
    novel.upgrade(p)
    if p["style_reference_mode"] not in ("card", "samples"):
        fail()
    book = obj(p["book_outline"])
    if not {"draft", "active", "version", "history"} <= book.keys():
        fail()
    if type(book.get("version")) is not int or book["version"] < 0:
        fail()
    direction(book["draft"])
    if book.get("active") is not None:
        direction(book["active"], active=True)
    for entry in items(book.get("history"), 20):
        if type(obj(entry).get("version")) is not int:
            fail()
        text(entry.get("at"), 100)
        direction(entry.get("outline"), active=True)
    draft_history = items(book.get("draft_history", []), 20)
    unique(draft_history)
    for entry in draft_history:
        text(entry.get("at"), 100)
        text(entry.get("reason"), 10000)
        direction(entry.get("draft"))
    for chapter in chapters:
        mapping(chapter)
    refs = items(p["references"], 40)
    reference_ids = unique(refs)
    for ref in refs:
        if ref.get("kind") not in ("style", "character"):
            fail()
        for key in ("title", "notes", "created_at"):
            text(ref.get(key), {"title": 200, "notes": 3000, "created_at": 100}[key])
        if "applied_at" in ref:
            text(ref["applied_at"], 100)
        if ref["kind"] == "style":
            text(ref.get("text"), 30000)
            boolean(ref.get("active"))
        else:
            if ref.get("entity_id") and (identifier(ref["entity_id"]) not in entity_ids or entity_map[ref["entity_id"]]["kind"] != "character"):
                fail()
            if type(ref.get("size")) is not int or ref["size"] <= 0:
                fail()
        analysis(ref.get("analysis"), ref["kind"])
        for entry in items(ref.get("analysis_history", []), 10):
            obj(entry)
            obj(entry.get("analysis"))
            text(entry.get("replaced_at"), 100)
            analysis(entry["analysis"], ref["kind"])
    for entity in entities:
        if any(rid not in reference_ids for rid in items(entity.get("reference_ids", []), 40)):
            fail()
    return p


def prepare(data, image_decoder):
    """Run identically for preview and import; never write or call a model."""
    if obj(data).get("format") != FORMAT or set(data) != {"format", "project", "images"}:
        fail()
    p = validate_project(copy.deepcopy(data["project"]))
    image_refs = {ref["id"]: ref for ref in p["references"] if ref["kind"] == "character"}
    if len(image_refs) > 12:
        fail()
    images = items(data["images"], 12)
    if unique(images) != set(image_refs):
        raise novel.StoryError("备份中的参考图缺失、重复或与作品不匹配，未恢复任何内容。")
    assets = []
    reference_map = {ref["id"]: novel.uid() for ref in p["references"]}
    for image in images:
        ref = image_refs[image["id"]]
        _, asset = image_decoder({"title": ref["title"], "base64": image.get("base64")})
        if image.get("mime") != asset["mime"] or ref.get("mime") != asset["mime"] or ref["size"] != len(asset["data"]):
            fail()
        asset["id"] = reference_map[image["id"]]
        assets.append(asset)
    for ref in p["references"]:
        ref["id"] = reference_map[ref["id"]]
    for entity in p["entities"]:
        if "reference_ids" in entity:
            entity["reference_ids"] = [reference_map[rid] for rid in entity["reference_ids"]]
    preview = {"format": FORMAT, "title": p["title"], "chapter_count": len(p["chapters"]),
               "entity_count": len(p["entities"]), "image_count": len(assets),
               "version_count": sum(len(c["versions"]) for c in p["chapters"]),
               "approved_count": sum(c["status"] == "approved" for c in p["chapters"])}
    p.update(id=novel.uid(), revision=0, is_demo=False, updated_at=novel.now())
    return p, assets, preview
