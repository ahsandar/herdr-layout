"""Pi (pi-coding-agent) session files to context operations.

Pull-only (local addition): Pi has no hook file and nothing is installed into it.
`pull.py` finds the newest session of a folder and reads it with `context.read`,
so there is no `normalize` here and `report.py` never loads this module.
Format: Pi's docs/session-format.md (version 3), one JSON object per line.
"""
import functools
import json
import os
from pathlib import Path
import re

from .common import add, item_time, number, obj, size, tool_label, tool_sizes

BOUNDARY = b'"type":"compaction"'
PINNED = (b'"role":"system"',)
# Prompt sections and tool schemas outlive their message, so they are kept in `calls`
# (context.read trims it to the newest entries; context_ops moves both keys to the end on every item).
SECTIONS, TOOLS = "\0pi.sections", "\0pi.tools"


def agent_dir():
    return Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi" / "agent").expanduser()


def locate(cwd):
    """(session id, path) of the newest session started in `cwd`, or None."""
    root = Path(os.environ.get("PI_CODING_AGENT_SESSION_DIR") or agent_dir() / "sessions").expanduser()
    # Pi names the folder after the path: no leading separator, `/`, `\` and `:` as `-`.
    name = re.sub(r"[/\\:]", "-", cwd.lstrip("/\\"))
    folder = root / f"--{name}--"
    try:
        newest = max(folder.glob("*.jsonl"), key=lambda path: path.stat().st_mtime)
    except (OSError, ValueError):  # No folder, or no session in it.
        return None
    return newest.stem.rsplit("_", 1)[-1], str(newest)


def find_window(value, model):
    """The `contextWindow` of the first entry named `model` in parsed JSON of any shape."""
    if isinstance(value, dict):
        if value.get("id") == model and isinstance(value.get("contextWindow"), int):
            return value["contextWindow"]
        value = list(value.values())
    for item in value if isinstance(value, list) else []:
        found = find_window(item, model)
        if found:
            return found
    return None


@functools.lru_cache(maxsize=64)
def window(provider, model):
    """The window from Pi's own model data: its list of built-in models for the provider, the
    cache of fetched lists, and the user's models.json. None when none of them knows it."""
    if not provider or not model or not re.fullmatch(r"[\w.-]+", provider):
        return None
    home = agent_dir()
    try:
        version = (home / "install" / "current-version").read_text().strip()
    except OSError:
        version = ""
    built_in = home / "install" / "releases" / version / "node_modules/@earendil-works/pi-ai/dist/providers/data" / f"{provider}.json"
    for path in (built_in, home / "models-store.json", home / "models.json"):
        try:
            found = find_window(json.loads(path.read_text()), model)
        except (OSError, ValueError):
            continue
        if found:
            return found
    return None


def context_window(_model):
    return None  # `model_ops` gives it, with the provider.


def keep(calls, key):
    value = calls.pop(key, {})
    calls[key] = value
    return value


def model_ops(provider, model):
    ops = [["model", model]] if isinstance(model, str) and model else []
    found = window(provider, model)
    return ops + ([["window", found]] if found else [])


def system_ops(message, calls):
    """A system message names prompt sections to set or remove (`null`) and tools to add or remove."""
    sections, tools = keep(calls, SECTIONS), keep(calls, TOOLS)
    for name, text in obj(message.get("sections")).items():
        if text is None:
            sections.pop(name, None)
        else:
            sections[name] = size(text)
    if not sections and message.get("content"):
        sections["Prompt"] = size(message["content"])
    tools.update(tool_sizes(message.get("toolsAdded")))
    for tool in message.get("toolsRemoved") or []:
        tools.pop(tool_label(obj(tool).get("name")), None)
    # The prompt's own tool list stands in until schemas are known.
    listed = sections.get("tools", 0)
    ops = [["pin", "system", {name: chars for name, chars in sections.items() if name not in {"tools", "skills"}}],
           ["pin", "tools", dict(tools) or ({"Tool list": listed} if listed else {})]]
    if sections.get("skills"):
        ops.append(["pin", "skills", {"Skills": sections["skills"]}])
    return ops


def compaction(item):
    before = item.get("tokensBefore")
    return {"at": item_time(item), "trigger": None, "took": None, "after": None,
            "before": before if isinstance(before, int) and before > 0 else None}


def is_boundary(item):
    return item.get("type") == "compaction"


def assistant_ops(item, message, calls):
    usage = obj(message.get("usage"))
    used = number(usage.get("totalTokens")) or sum(number(usage.get(key)) for key in ("input", "output", "cacheRead", "cacheWrite"))
    ops = []
    if used > 0:
        write = number(usage.get("cacheWrite"))
        ops += model_ops(message.get("provider"), message.get("model")) + [
            ["usage", int(used)],
            # Pi reports cache writes only for providers that bill them; without one no miss is found.
            ["cache", {"id": item.get("id"), "model": message.get("model"), "read": int(number(usage.get("cacheRead"))),
                       "write": int(write) if write else None, "uncached": int(number(usage.get("input"))), "ttl": None}]]
    content = message.get("content")
    for block in [{"type": "text", "text": content}] if isinstance(content, str) else content if isinstance(content, list) else []:
        block = obj(block)
        if block.get("type") == "text":
            ops.append(add("messages", size(block.get("text")), "Assistant"))
        elif block.get("type") == "thinking":
            ops.append(add("messages", size(block.get("thinking")), "Thinking"))
        elif block.get("type") == "toolCall":
            part = tool_label(block.get("name"))
            if isinstance(block.get("id"), str):
                calls[block["id"]] = part
            ops.append(add("messages", size(block.get("arguments")), part))
    return ops


def context_ops(item, calls):
    # Every item moves both to the end of `calls`, so the trimming in context.read never drops them.
    keep(calls, SECTIONS)
    keep(calls, TOOLS)
    kind = item.get("type")
    if kind == "model_change":
        return model_ops(item.get("provider"), item.get("modelId"))
    if kind == "compaction":
        ops = [["reset", compaction(item)], add("messages", size(item.get("summary")), "Summary")]
        checkpoint = obj(item.get("systemMessage"))
        if checkpoint:
            calls.pop(SECTIONS, None)
            calls.pop(TOOLS, None)
            ops += system_ops(checkpoint, calls)
        return ops
    if kind == "branch_summary":
        return [add("messages", size(item.get("summary")), "Summary")]
    if kind == "custom_message":
        return [add("messages", size(item.get("content")), "Extension")]
    if kind != "message":
        return []
    message = obj(item.get("message"))
    role = message.get("role")
    if role == "system":
        return system_ops(message, calls)
    if role == "assistant":
        return assistant_ops(item, message, calls)
    if role == "user":
        return [["sent", item_time(item)], add("messages", size(message.get("content")), "You")]
    if role == "toolResult":
        part = calls.get(message.get("toolCallId")) or tool_label(message.get("toolName"))
        return [["sent", item_time(item)], add("messages", size(message.get("content")), part)]
    # Pi's own roles (bashExecution, custom, summaries) all carry text the model sees.
    return [add("messages", size(message.get("content") or message.get("output") or message.get("summary")), "Other")]
