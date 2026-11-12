"""Local addition: context for Pi and opencode, read without hooks (pull.py).

Run: python3 -m unittest test_pull   (from this folder)
Pi's file is built from its documented session format; opencode's database mirrors the real
tables (checked against a real database). Neither agent is needed to run these.
"""
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

import pull
from providers import opencode, pi

CWD = "/work/demo"


def line(**item):
    return json.dumps(item)


def message(identifier, role, at, **fields):
    return line(type="message", id=identifier, parentId=None, timestamp=at, message={"role": role, **fields})


def assistant(identifier, at, usage, content):
    return message(identifier, "assistant", at, provider="anthropic", model="claude-demo", usage=usage, content=content,
                   stopReason="stop")


class PiContext(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        root = Path(self.home.name)
        env = mock.patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(root), "PI_CODING_AGENT_SESSION_DIR": ""})
        env.start()
        self.addCleanup(env.stop)
        pi.window.cache_clear()
        (root / "models-store.json").write_text(json.dumps(
            {"anthropic": {"models": [{"id": "claude-demo", "contextWindow": 200000}]}}))
        self.folder = root / "sessions" / "--work-demo--"
        self.folder.mkdir(parents=True)
        self.path = self.folder / "2026-01-01T00-00-00-000Z_abc123.jsonl"
        self.cache = root / "cache"
        self.lines = [
            line(type="session", version=3, id="abc123", timestamp="2026-01-01T00:00:00.000Z", cwd=CWD),
            message("s1", "system", "2026-01-01T00:00:01.000Z", content="",
                    sections={"preamble": "x" * 700, "tools": "y" * 70}, toolsAdded=[{"name": "bash", "description": "z" * 350}]),
            message("u1", "user", "2026-01-01T00:00:02.000Z", content="hello " * 100),
            assistant("a1", "2026-01-01T00:00:03.000Z",
                      {"input": 900, "output": 100, "cacheRead": 0, "cacheWrite": 400, "totalTokens": 1400},
                      [{"type": "text", "text": "ok"},
                       {"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "ls"}}]),
            message("r1", "toolResult", "2026-01-01T00:00:04.000Z", toolCallId="c1", toolName="bash",
                    content=[{"type": "text", "text": "file " * 200}]),
        ]
        self.write()

    def write(self):
        self.path.write_text("\n".join(self.lines) + "\n")

    def label(self):
        return json.loads(pull.pull("pi", CWD, self.cache))

    def test_total_window_rows_and_cache(self):
        label = self.label()
        self.assertEqual((label["provider"], label["sessionId"], label["model"]), ("pi", "abc123", "claude-demo"))
        self.assertEqual((label["used"], label["window"], label["exact"]), (1400, 200000, True))
        rows = {row["key"]: row for row in label["rows"]}
        self.assertEqual({"messages", "system", "tools"}, set(rows))
        # `Other` holds what the file cannot explain (here: the gap between the rows and the exact total).
        self.assertEqual({part["label"] for part in rows["messages"]["parts"]} - {"Other"}, {"You", "Assistant", "bash"})
        self.assertEqual((label["cache"]["requests"], label["cache"]["written"]), (1, 400))

    def test_reads_only_new_lines_and_follows_the_newest_session(self):
        self.label()
        before = json.loads(self.cache.joinpath(next(self.cache.iterdir()).name).read_text())["offset"]
        self.lines.append(assistant("a2", "2026-01-01T00:00:05.000Z",
                                    {"input": 100, "output": 50, "cacheRead": 1300, "cacheWrite": 0, "totalTokens": 1450},
                                    [{"type": "text", "text": "done"}]))
        self.write()
        self.assertEqual(self.label()["used"], 1450)
        self.assertGreater(json.loads(next(self.cache.glob("*.json")).read_text())["offset"], before)

    def test_compaction_resets_and_is_logged(self):
        self.lines += [line(type="compaction", id="k1", parentId=None, timestamp="2026-01-01T00:01:00.000Z",
                            summary="short summary", firstKeptEntryId="k1", tokensBefore=1400),
                       assistant("a3", "2026-01-01T00:01:05.000Z", {"input": 300, "output": 20, "totalTokens": 320}, [])]
        self.write()
        label = self.label()
        self.assertEqual((label["compactions"], label["used"]), (1, 320))
        self.assertEqual(label["log"][0]["before"], 1400)
        self.assertEqual(label["log"][0]["after"], 320)  # the first request after it

    def test_failed_request_with_no_usage_keeps_the_last_total(self):
        self.lines.append(assistant("a4", "2026-01-01T00:00:06.000Z", {"input": 0, "output": 0, "totalTokens": 0}, []))
        self.write()
        self.assertEqual(self.label()["used"], 1400)

    def test_prompt_sections_survive_many_tool_calls_before_a_patch(self):
        for n in range(450):  # more than context.MAX_CALLS, so the reader trims its call table
            self.lines += [
                message(f"x{n}", "assistant", "2026-01-01T00:00:05.000Z", provider="anthropic", model="claude-demo",
                        usage={"totalTokens": 2000 + n}, stopReason="toolUse",
                        content=[{"type": "toolCall", "id": f"k{n}", "name": "bash", "arguments": {"command": "ls"}}]),
                message(f"y{n}", "toolResult", "2026-01-01T00:00:06.000Z", toolCallId=f"k{n}", toolName="bash", content="ok")]
        self.write()
        self.assertTrue({"system", "tools"} <= {row["key"] for row in self.label()["rows"]})
        # A later system message patches one section; the others must stay.
        self.lines.append(message("s2", "system", "2026-01-01T00:02:00.000Z", content="", sections={"skills": "k" * 350}))
        self.write()
        self.assertTrue({"system", "tools", "skills"} <= {row["key"] for row in self.label()["rows"]})

    def test_built_in_window_comes_from_the_installed_package(self):
        root = Path(self.home.name)
        (root / "models-store.json").write_text("{}")
        (root / "install").mkdir()
        (root / "install" / "current-version").write_text("9.9.9\n")
        data = root / "install/releases/9.9.9/node_modules/@earendil-works/pi-ai/dist/providers/data"
        data.mkdir(parents=True)
        (data / "anthropic.json").write_text(json.dumps(
            {"anthropic-messages": {"chat:claude-demo": {"id": "claude-demo", "contextWindow": 777000}}}))
        pi.window.cache_clear()
        self.assertEqual(self.label()["window"], 777000)

    def test_no_session_for_the_folder(self):
        self.assertIsNone(pull.pull("pi", "/work/other", self.cache))

    def test_unknown_window_leaves_it_out(self):
        pi.window.cache_clear()
        (Path(self.home.name) / "models-store.json").write_text("{}")
        self.assertNotIn("window", self.label())

    def test_window_finds_an_entry_in_any_json_shape(self):
        self.assertEqual(pi.find_window({"a": {"chat:m": {"id": "m", "contextWindow": 5}}}, "m"), 5)
        self.assertIsNone(pi.find_window([{"id": "m"}], "m"))


class OpencodeContext(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        root = Path(self.home.name)
        env = mock.patch.dict(os.environ, {"XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache")})
        env.start()
        self.addCleanup(env.stop)
        (root / "cache" / "opencode").mkdir(parents=True)
        (root / "cache" / "opencode" / "models.json").write_text(json.dumps(
            {"demo": {"models": {"m-1": {"limit": {"context": 128000, "output": 8000}}}}}))
        (root / "data" / "opencode").mkdir(parents=True)
        self.db = sqlite3.connect(root / "data" / "opencode" / "opencode.db")
        self.db.executescript("""
            CREATE TABLE session (id text PRIMARY KEY, directory text, parent_id text, time_updated integer, time_archived integer);
            CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
            CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);""")
        self.count = 0
        self.cache = root / "pullcache"

    def session(self, identifier, directory=CWD, parent=None, updated=1):
        self.db.execute("INSERT INTO session VALUES (?,?,?,?,NULL)", (identifier, directory, parent, updated))

    def message(self, session, role, at, parts, **data):
        self.count += 1
        identifier = f"m{self.count}"
        self.db.execute("INSERT INTO message VALUES (?,?,?,?,?)", (identifier, session, at, at, json.dumps({"role": role, **data})))
        for part in parts:
            self.count += 1
            self.db.execute("INSERT INTO part VALUES (?,?,?,?,?,?)", (f"p{self.count}", identifier, session, at, at, json.dumps(part)))
        self.db.commit()

    def reply(self, session, at, tokens, parts=(), **data):
        self.message(session, "assistant", at, parts, providerID="demo", modelID="m-1", tokens=tokens, **data)

    def label(self):
        return json.loads(pull.pull("opencode", CWD, self.cache))

    def test_total_window_model_and_rows(self):
        self.session("s1")
        self.message("s1", "user", 1000, [{"type": "text", "text": "q" * 350}])
        self.reply("s1", 2000, {"input": 900, "output": 60, "reasoning": 5, "cache": {"read": 40, "write": 0}},
                   [{"type": "tool", "tool": "read", "state": {"input": {"filePath": "a"}, "output": "o" * 700}},
                    {"type": "text", "text": "done"}])
        label = self.label()
        self.assertEqual((label["used"], label["window"], label["model"]), (1000, 128000, "m-1"))
        parts = {part["label"]: part["tokens"] for row in label["rows"] for part in row["parts"]}
        self.assertGreater(parts["read"], parts["You"])
        self.assertEqual(label["cache"], {"requests": 1, "read": 40, "uncached": 900, "since": 1})

    def test_pruned_tool_output_is_not_counted(self):
        self.session("s1")
        call = {"type": "tool", "tool": "read", "state": {"input": {"filePath": "a"}, "output": "o" * 7000}}
        self.reply("s1", 2000, {"input": 10, "output": 1, "cache": {}}, [call])
        chars = lambda: sum(op[2] for op in opencode.build(CWD)[2] if op[0] == "add" and op[3] == "read")
        full = chars()
        call["state"]["time"] = {"compacted": 1}
        self.db.execute("UPDATE part SET data = ?", (json.dumps(call),))
        self.db.commit()
        self.assertGreater(full, 7000)
        self.assertLess(chars(), 100)  # only the call's input is left

    def test_subagent_and_other_folders_are_ignored(self):
        self.session("main", updated=1)
        self.session("child", parent="main", updated=9)
        self.session("elsewhere", directory="/other", updated=9)
        self.reply("main", 2000, {"input": 100, "output": 1, "cache": {}})
        self.reply("child", 3000, {"input": 999, "output": 1, "cache": {}})
        self.assertEqual(self.label()["used"], 101)

    def test_summary_message_is_a_compaction(self):
        self.session("s1")
        self.reply("s1", 2000, {"input": 5000, "output": 1, "cache": {}})
        self.reply("s1", 3000, {"input": 300, "output": 1, "cache": {}}, [{"type": "text", "text": "summary"}], summary=True)
        label = self.label()
        self.assertEqual((label["compactions"], label["used"], label["log"][0]["before"]), (1, 301, 5001))

    def test_no_session_no_database(self):
        self.assertIsNone(pull.pull("opencode", "/nowhere", self.cache))
        Path(opencode.database()).unlink()
        self.assertIsNone(pull.pull("opencode", CWD, self.cache))

    def test_unchanged_session_is_not_rebuilt(self):
        self.session("s1")
        self.reply("s1", 2000, {"input": 100, "output": 1, "cache": {}}, [{"type": "tool", "tool": "read",
                   "state": {"input": {}, "output": "o"}}])
        first = opencode.build(CWD)
        self.assertIsNotNone(first[2])
        self.assertIsNone(opencode.build(CWD, first[1])[2])  # same fingerprint: nothing is read
        label = pull.pull("opencode", CWD, self.cache)
        with mock.patch.object(pull.context, "apply", side_effect=AssertionError("rebuilt")):
            self.assertEqual(pull.pull("opencode", CWD, self.cache), label)
        # A part updated in place (a tool call finishing) changes the fingerprint without changing any count.
        self.db.execute("UPDATE part SET time_updated = 9999, data = ?", (json.dumps(
            {"type": "tool", "tool": "read", "state": {"input": {}, "output": "o" * 7000}}),))
        self.db.commit()
        self.assertNotEqual(opencode.build(CWD, first[1])[1], first[1])
        self.assertNotEqual(pull.pull("opencode", CWD, self.cache), label)
        # And a new message does too.
        self.reply("s1", 3000, {"input": 400, "output": 1, "cache": {}})
        self.assertEqual(self.label()["used"], 401)

    def test_only_known_agents_are_pulled(self):
        self.assertIsNone(pull.pull("claude", CWD))


if __name__ == "__main__":
    unittest.main()
