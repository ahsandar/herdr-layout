// Local addition. Run: node mods/bettr-context/model.test.mjs
import assert from "node:assert/strict";
import { HOOKLESS, contextState, focusedAgent } from "./model.js";

const label = provider => JSON.stringify({ version: 1, provider, rows: [], used: 5 });
const pulled = label("opencode");

// A stale Claude label in a terminal that now runs opencode must not hide the pulled state.
const opencode = { address: "t1", state: "live", program: { key: "opencode", agent: false }, status: null,
  labels: { "bettr.context": label("claude") } };
assert.equal(contextState(opencode, pulled)?.provider, "opencode");
assert.equal(contextState(opencode, null), null); // and the stale label alone shows nothing

// Claude is unchanged: its hook label is used, and pulled text is ignored.
const claude = { address: "t2", state: "live", program: { key: "claude", agent: true }, status: "idle",
  labels: { "bettr.context": label("claude") } };
assert.equal(contextState(claude, pulled)?.provider, "claude");

// A hook-less agent counts as an agent even though Herdr gives it no status.
assert.ok(HOOKLESS.has("pi") && HOOKLESS.has("opencode") && !HOOKLESS.has("claude"));
assert.equal(focusedAgent({ terminal: "t1" }, [opencode], []), opencode);
assert.equal(focusedAgent({ terminal: "t3" }, [{ address: "t3", state: "live", program: { key: "shell" }, status: null }], []), null);
console.log("model.test.mjs ok");
