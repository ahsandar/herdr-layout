"""Local patch: search items and agent names/descriptions are redacted like every other published text.

Run: python3 -m unittest test_redaction_patch   (from this folder)
"""
import unittest

from providers import classify, common


class RedactionPatch(unittest.TestCase):
    def test_search_items_are_redacted(self):
        entry = classify.entry("search", items=["api_key=sk-abcdefghijkl1234", "plain"])
        self.assertEqual(entry["items"], ["api_key=…", "plain"])

    def test_agent_free_text_is_redacted(self):
        event = common.agent("agent.meta", {"session_id": "s"}, "a1",
                             name="token=abcdef123456", description="deploy with password=hunter2xx", model="m")
        self.assertNotIn("hunter2", event["fields"]["description"])
        self.assertNotIn("abcdef123456", event["fields"]["name"])
        self.assertEqual(event["fields"]["model"], "m")  # identifiers pass through unchanged


if __name__ == "__main__":
    unittest.main()
