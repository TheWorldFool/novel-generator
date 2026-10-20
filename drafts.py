"""Small, revision-independent SQLite store for unfinished author input."""
import json
import math
import re

import novel


MAX_VALUE_BYTES = 1_200_000
MAX_MEMORY_VALUE_BYTES = 4_000_000
MAX_REWRITE_VALUE_BYTES = 6_000_000
MAX_PROJECT_BYTES = 20_000_000
MAX_ACTIVE_DRAFTS = 100
KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9_:.-]{0,179}\Z")
PRIVATE_FIELDS = {"apikey", "password", "passwd", "secret", "token", "accesstoken",
                  "authorization", "credential", "credentials", "base64", "file",
                  "filepath", "path", "imagedata", "dataurl"}


class DraftConflict(novel.StoryError):
    pass


def init(db):
    db.execute("""CREATE TABLE IF NOT EXISTS work_drafts (
        project_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
        version INTEGER NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, key))""")


def validate_key(key):
    if not isinstance(key, str) or not KEY.fullmatch(key):
        raise novel.StoryError("草稿标记无效，请重新打开编辑窗口。")
    return key


def _validate(value, depth=0):
    if depth > 16:
        raise novel.StoryError("草稿层级过深，请简化输入后重试。")
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str) or len(key) > 120:
                raise novel.StoryError("草稿字段无效。")
            normalized = re.sub(r"[^a-z0-9]", "", key.lower())
            if normalized in PRIVATE_FIELDS:
                raise novel.StoryError("草稿不保存密钥、文件内容或设备路径。")
            _validate(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            _validate(child, depth + 1)
    elif type(value) is float and not math.isfinite(value):
        raise novel.StoryError("草稿含有无效数值。")
    elif value is not None and not isinstance(value, (str, int, float, bool)):
        raise novel.StoryError("草稿仅支持文字和选项。")


def _record(key, row):
    if not row:
        return {"key": key, "value": None, "version": 0, "updated_at": None}
    return {"key": key, "value": json.loads(row[0]) if row[0] is not None else None,
            "version": row[1], "updated_at": row[2]}


def handle(db, pid, data):
    """Caller holds a write transaction and verifies project ownership/existence."""
    if not isinstance(data, dict):
        raise novel.StoryError("草稿请求格式无效。")
    key = validate_key(data.get("key"))
    action = data.get("action")
    if action not in ("read", "write", "delete"):
        raise novel.StoryError("未知草稿操作。")
    row = db.execute("SELECT value, version, updated_at FROM work_drafts WHERE project_id=? AND key=?",
                     (pid, key)).fetchone()
    if action == "read":
        return {"draft": _record(key, row)}
    expected = data.get("expected_version")
    if type(expected) is not int or expected < 0:
        raise novel.StoryError("草稿版本无效，请重新打开编辑窗口。")
    if expected != (row[1] if row else 0):
        raise DraftConflict("这份草稿已在其他窗口更新。当前输入仍在本窗口，请先复制保留，再重新打开核对。")
    encoded = None
    if action == "write":
        value = data.get("value")
        if not isinstance(value, dict):
            raise novel.StoryError("草稿内容须为文字与选项组成的对象。")
        _validate(value)
        try:
            encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            size = len(encoded.encode("utf-8"))
        except (TypeError, ValueError, UnicodeError):
            raise novel.StoryError("草稿内容格式无效。") from None
        limit = (MAX_REWRITE_VALUE_BYTES if key.startswith("proposal:rewrite:") else
                 MAX_MEMORY_VALUE_BYTES if key.startswith("memory:") else MAX_VALUE_BYTES)
        if size > limit:
            raise novel.StoryError(f"这份草稿超过{limit / 1_000_000:g}MB，请先保存或缩短内容。当前输入仍保留在窗口中。")
        count, total = db.execute("SELECT COUNT(*), COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM work_drafts WHERE project_id=? AND value IS NOT NULL", (pid,)).fetchone()
        if (not row or row[0] is None) and count >= MAX_ACTIVE_DRAFTS:
            raise novel.StoryError("该作品已有100份未完成草稿，请先保存或放弃部分草稿。")
        previous_size = len(row[0].encode("utf-8")) if row and row[0] is not None else 0
        if total - previous_size + size > MAX_PROJECT_BYTES:
            raise novel.StoryError("该作品的未完成草稿超过20MB，请先保存或放弃部分草稿。")
    version, at = expected + 1, novel.now()
    db.execute("INSERT INTO work_drafts(project_id,key,value,version,updated_at) VALUES (?,?,?,?,?) "
               "ON CONFLICT(project_id,key) DO UPDATE SET value=excluded.value,version=excluded.version,updated_at=excluded.updated_at",
               (pid, key, encoded, version, at))
    return {"draft": {"key": key, "value": json.loads(encoded) if encoded is not None else None,
                      "version": version, "updated_at": at}}


def list_drafts(db, pid):
    rows = db.execute("SELECT key,value,version,updated_at FROM work_drafts WHERE project_id=? AND value IS NOT NULL ORDER BY updated_at DESC,key", (pid,))
    return {"drafts": [_record(row[0], row[1:]) for row in rows]}
