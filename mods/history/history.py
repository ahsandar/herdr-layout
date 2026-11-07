#!/usr/bin/env python3
"""Indexes and reads coding-agent session transcripts for the History panel.

  history.py list            -> JSON array of sessions, newest first
  history.py show AGENT REF  -> JSON array of messages for one session

Sources: Claude Code, Codex and Pi (jsonl files). Per-file results are cached
by (mtime, size) so a refresh only re-reads transcripts that changed.
"""
import glob
import json
import os
import sys

HOME = os.path.expanduser("~")
CACHE = os.path.join(HOME, ".cache", "herdr-history", "index.json")
CACHE_VERSION = 3
TITLE_MAX = 160
TEXT_MAX = 6000
SHOW_MAX = 400


def clip(text, n):
    text = " ".join(str(text).split()) if n <= TITLE_MAX else str(text)
    return text if len(text) <= n else text[: n - 1] + "…"


def ms(ts):
    """ISO-8601 string or epoch number -> epoch milliseconds."""
    if ts is None:
        return 0
    if isinstance(ts, (int, float)):
        return int(ts if ts > 1e12 else ts * 1000)
    from datetime import datetime
    try:
        return int(datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def noise(text):
    """Injected context rather than something the person typed."""
    t = text.lstrip()
    return (not t or t.startswith("<") or t.startswith("# AGENTS.md")
            or t.startswith("Caveat:") or t.startswith("[Request interrupted"))


def jsonl(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def text_of(content, roles=("text", "input_text", "output_text")):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content
                         if isinstance(p, dict) and p.get("type", "text") in roles and p.get("text"))
    return ""


def tool_line(name, args):
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            return f"{name} {clip(args, 200)}"
    if isinstance(args, dict):
        for k in ("command", "cmd", "file_path", "path", "pattern", "query", "url", "description", "prompt"):
            if args.get(k):
                v = args[k]
                return f"{name} · {clip(' '.join(v) if isinstance(v, list) else v, 200)}"
    return name


# ---------- Claude Code ----------

def claude_index(path):
    title = ai_title = first = cwd = None
    created = updated = 0
    turns = 0
    sid = os.path.splitext(os.path.basename(path))[0]
    for d in jsonl(path):
        t = d.get("type")
        if t == "ai-title":
            ai_title = d.get("aiTitle") or ai_title
        elif t in ("custom-title", "summary"):
            title = d.get("customTitle") or d.get("summary") or title
        elif t == "workspace-directories" and not cwd:
            cwd = (d.get("directories") or [None])[0]
        elif t in ("user", "assistant"):
            if d.get("isSidechain"):
                continue
            cwd = cwd or d.get("cwd")
            ts = ms(d.get("timestamp"))
            if ts:
                created = created or ts
                updated = max(updated, ts)
            if t == "user" and not d.get("isMeta"):
                text = text_of((d.get("message") or {}).get("content"), ("text",))
                if text and not noise(text):
                    turns += 1
                    first = first or text
    if not turns:
        return None
    return {"agent": "claude", "id": sid, "file": path, "cwd": cwd, "created": created,
            "updated": updated, "turns": turns,
            "title": clip(title or ai_title or first, TITLE_MAX)}


def claude_show(path):
    out = []
    for d in jsonl(path):
        t = d.get("type")
        if t not in ("user", "assistant") or d.get("isSidechain") or d.get("isMeta"):
            continue
        content = (d.get("message") or {}).get("content")
        ts = ms(d.get("timestamp"))
        if isinstance(content, str):
            if t == "user" and noise(content):
                continue
            out.append({"role": t, "text": content, "time": ts})
            continue
        for p in content or []:
            if not isinstance(p, dict):
                continue
            k = p.get("type")
            if k == "text" and p.get("text"):
                if t == "user" and noise(p["text"]):
                    continue
                out.append({"role": t, "text": p["text"], "time": ts})
            elif k == "tool_use":
                out.append({"role": "tool", "text": tool_line(p.get("name", "tool"), p.get("input")), "time": ts})
    return out


# ---------- Codex ----------

def codex_items(path):
    for d in jsonl(path):
        p = d.get("payload") or {}
        yield d, p


def codex_index(path):
    sid = cwd = first = None
    created = updated = turns = 0
    for d, p in codex_items(path):
        ts = ms(d.get("timestamp"))
        if d.get("type") == "session_meta":
            src = p.get("source")
            if isinstance(src, dict) and "subagent" in src:
                return None  # reviewer/sub-agent threads, not a conversation
            sid = p.get("id") or p.get("session_id")
            cwd = p.get("cwd")
            created = ms(p.get("timestamp")) or ts
        if ts:
            updated = max(updated, ts)
        if d.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
            text = text_of(p.get("content"))
            if text and not noise(text):
                turns += 1
                first = first or text
    if not sid or not turns:
        return None
    return {"agent": "codex", "id": sid, "file": path, "cwd": cwd, "created": created,
            "updated": updated, "turns": turns, "title": clip(first, TITLE_MAX)}


def codex_show(path):
    out = []
    for d, p in codex_items(path):
        if d.get("type") != "response_item":
            continue
        ts = ms(d.get("timestamp"))
        k = p.get("type")
        if k == "message" and p.get("role") in ("user", "assistant"):
            text = text_of(p.get("content"))
            if text and not (p["role"] == "user" and noise(text)):
                out.append({"role": p["role"], "text": text, "time": ts})
        elif k in ("function_call", "custom_tool_call", "local_shell_call"):
            out.append({"role": "tool", "time": ts,
                        "text": tool_line(p.get("name") or "shell", p.get("arguments") or p.get("input") or p.get("action"))})
    return out


def codex_titles():
    names = {}
    path = os.path.join(HOME, ".codex", "session_index.jsonl")
    if os.path.exists(path):
        for d in jsonl(path):
            if d.get("id") and d.get("thread_name"):
                names[d["id"]] = d["thread_name"]
    return names


# ---------- Pi ----------

def pi_index(path):
    sid = cwd = title = first = None
    created = updated = turns = 0
    for d in jsonl(path):
        ts = ms(d.get("timestamp"))
        updated = max(updated, ts)
        if d.get("type") == "session":
            sid, cwd, created = d.get("id"), d.get("cwd"), ts
        elif d.get("type") == "session_info":
            title = d.get("name")
        elif d.get("type") == "message":
            m = d.get("message") or {}
            if m.get("role") == "user":
                text = text_of(m.get("content"))
                if text and not noise(text):
                    turns += 1
                    first = first or text
    if not sid or not turns:
        return None
    return {"agent": "pi", "id": sid, "file": path, "cwd": cwd, "created": created,
            "updated": updated, "turns": turns, "title": clip(title or first, TITLE_MAX)}


def pi_show(path):
    out = []
    for d in jsonl(path):
        if d.get("type") != "message":
            continue
        m = d.get("message") or {}
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        ts = ms(d.get("timestamp") or m.get("timestamp"))
        content = m.get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        # Match the other readers: show visible text and tool calls, omitting
        # thinking, images and tool results that would duplicate the call list.
        for p in content or []:
            if not isinstance(p, dict):
                continue
            if p.get("type") == "text" and p.get("text"):
                if role == "user" and noise(p["text"]):
                    continue
                out.append({"role": role, "text": p["text"], "time": ts})
            elif role == "assistant" and p.get("type") == "toolCall":
                out.append({"role": "tool", "text": tool_line(p.get("name", "tool"), p.get("arguments")), "time": ts})
    return out


# ---------- driver ----------

def file_sources():
    for f in glob.glob(os.path.join(HOME, ".claude", "projects", "*", "*.jsonl")):
        yield "claude", f
    for f in glob.glob(os.path.join(HOME, ".codex", "sessions", "*", "*", "*", "*.jsonl")):
        yield "codex", f
    pi_home = os.path.expanduser(os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(HOME, ".pi", "agent"))
    pi_sessions = os.path.expanduser(os.environ.get("PI_CODING_AGENT_SESSION_DIR") or os.path.join(pi_home, "sessions"))
    for f in glob.glob(os.path.join(pi_sessions, "**", "*.jsonl"), recursive=True):
        yield "pi", f


def index_file(agent, path):
    if agent == "claude":
        return claude_index(path)
    if agent == "codex":
        return codex_index(path)
    if agent == "pi":
        return pi_index(path)
    return None


def cmd_list():
    try:
        with open(CACHE) as f:
            cache = json.load(f)
        if cache.get("v") != CACHE_VERSION:
            cache = {}
    except (OSError, ValueError):
        cache = {}
    files = cache.get("files", {})
    fresh, sessions = {}, []
    for agent, path in file_sources():
        try:
            st = os.stat(path)
        except OSError:
            continue
        stamp = [int(st.st_mtime * 1000), st.st_size]
        hit = files.get(path)
        if hit and hit.get("stamp") == stamp:
            entry = hit.get("session")
        else:
            try:
                entry = index_file(agent, path)
            except Exception:  # one unreadable transcript never hides the rest
                entry = None
        fresh[path] = {"stamp": stamp, "session": entry}
        if entry:
            sessions.append(entry)
    try:
        if fresh == files:
            raise OSError  # nothing changed: leave the file alone
        # The index holds prompt titles and folders: keep it private to this user.
        folder = os.path.dirname(CACHE)
        os.makedirs(folder, mode=0o700, exist_ok=True)
        os.chmod(folder, 0o700)
        tmp = CACHE + ".tmp"
        with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
            json.dump({"v": CACHE_VERSION, "files": fresh}, f)
        os.replace(tmp, CACHE)
    except OSError:
        pass
    names = codex_titles()
    for s in sessions:
        if s["agent"] == "codex" and s["id"] in names:
            s["title"] = clip(names[s["id"]], TITLE_MAX)
    sessions.sort(key=lambda s: s.get("updated") or 0, reverse=True)
    return sessions


def cmd_show(agent, ref):
    if agent == "claude":
        msgs = claude_show(ref)
    elif agent == "codex":
        msgs = codex_show(ref)
    elif agent == "pi":
        msgs = pi_show(ref)
    else:
        msgs = []
    # Merge consecutive tool lines so a long tool burst reads as one block.
    merged = []
    for m in msgs:
        m["text"] = clip(m["text"].strip(), TEXT_MAX)
        if not m["text"]:
            continue
        if merged and m["role"] == "tool" and merged[-1]["role"] == "tool":
            merged[-1]["text"] += "\n" + m["text"]
        else:
            merged.append(m)
    total = len(merged)
    return {"total": total, "messages": merged[-SHOW_MAX:]}


def main():
    args = sys.argv[1:]
    if args[:1] == ["list"]:
        result = cmd_list()
    elif args[:1] == ["show"] and len(args) == 3:
        result = cmd_show(args[1], args[2])
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
