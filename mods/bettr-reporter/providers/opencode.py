"""opencode's local database to context operations.

Pull-only (local addition): nothing is installed into opencode. It keeps sessions in SQLite, not
a transcript file, so `pull.py` calls `build` and applies the operations itself.
Read-only; needs SQLite's JSON functions (3.38, 2022, or newer).
"""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3

from .common import IMAGE_CHARS, add, number, tool_label


def database():
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "opencode" / "opencode.db"


def catalogue():
    """opencode's own copy of the models.dev list: {provider: {"models": {id: {"limit": {"context": n}}}}}."""
    path = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "opencode" / "models.json"
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def window(known, provider, model):
    try:
        found = known[provider]["models"][model]["limit"]["context"]
    except (KeyError, TypeError):
        return None
    return found if isinstance(found, int) and found > 0 else None


def context_window(_model):
    return None  # `build` gives it, with the provider.


PARTS = """
SELECT message_id, json_extract(data, '$.type'), json_extract(data, '$.tool'),
       length(json_extract(data, '$.text')), length(json_extract(data, '$.state.input')),
       length(json_extract(data, '$.state.output')), json_extract(data, '$.state.time.compacted'),
       json_extract(data, '$.mime')
FROM part WHERE session_id = ? ORDER BY time_created, id"""


def part_ops(role, row):
    """Operations for one part. Sizes come from SQL, so a big tool output is never loaded."""
    _, kind, tool, text, given, output, pruned, mime = row
    if kind == "text":
        return [add("messages", text or 0, "You" if role == "user" else "Assistant")]
    if kind == "reasoning":
        return [add("messages", text or 0, "Thinking")]
    if kind == "tool":
        # opencode drops the output of old calls from the prompt once it has pruned them.
        return [add("messages", (given or 0) + (0 if pruned else output or 0), tool_label(tool))]
    if kind == "file" and isinstance(mime, str) and mime.startswith("image/"):
        return [add("messages", IMAGE_CHARS, "Images")]
    return []


def usage_ops(known, data, used):
    """The context size after this request, and its cache figures."""
    tokens = data.get("tokens") or {}
    cache = tokens.get("cache") or {}
    provider, model = data.get("providerID"), data.get("modelID")
    total = sum(number(value) for value in (tokens.get("input"), tokens.get("output"), cache.get("read"), cache.get("write")))
    if total <= 0:
        return [], used
    ops = [["usage", int(total)], ["cache", {"id": data.get("id"), "model": model, "read": int(number(cache.get("read"))),
                                            "write": int(number(cache.get("write"))) or None,
                                            "uncached": int(number(tokens.get("input"))), "ttl": None}]]
    if isinstance(model, str) and model:
        ops.insert(0, ["model", model])
        found = window(known, provider, model)
        if found:
            ops.insert(1, ["window", found])
    return ops, int(total)


FINGERPRINT = """
SELECT (SELECT count(*) || ':' || ifnull(max(time_updated), 0) FROM part WHERE session_id = ?),
       (SELECT count(*) || ':' || ifnull(max(time_updated), 0) FROM message WHERE session_id = ?)"""


def build(cwd, known=None):
    """(session id, fingerprint, operations) for the newest main session started in `cwd`, or None.

    The fingerprint changes when a message or part is added or updated. When it equals `known`,
    nothing is read beyond it and the operations are None: the caller's earlier result still holds.

    Compaction: an assistant message marked `summary` replaces what came before it.
    That marker is taken from opencode's message format and has not been seen in a real session here.
    """
    path = database()
    if not path.is_file():
        return None
    models = catalogue()
    try:
        with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=0.5)) as db:
            session = db.execute("SELECT id FROM session WHERE directory = ? AND parent_id IS NULL AND time_archived IS NULL "
                                 "ORDER BY time_updated DESC LIMIT 1", (cwd,)).fetchone()
            if not session:
                return None
            fingerprint = f"{session[0]}|" + "|".join(db.execute(FINGERPRINT, (session[0], session[0])).fetchone())
            if fingerprint == known:
                return session[0], fingerprint, None
            messages = db.execute("SELECT id, time_created, data FROM message WHERE session_id = ? "
                                  "ORDER BY time_created, id", (session[0],)).fetchall()
            parts = {}
            for row in db.execute(PARTS, (session[0],)):
                parts.setdefault(row[0], []).append(row)
    except sqlite3.Error:
        return None
    ops, used = [], None
    for identifier, created, raw in messages:
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        role = data.get("role")
        if role == "assistant" and data.get("summary") is True:
            ops.append(["reset", {"at": created / 1000, "trigger": None, "took": None, "after": None, "before": used}])
        if role == "user":
            ops.append(["sent", created / 1000])
        for row in parts.get(identifier, []):
            ops += part_ops(role, row)
        if role == "assistant":
            more, used = usage_ops(models, {**data, "id": identifier}, used)
            ops += more
    return session[0], fingerprint, ops
