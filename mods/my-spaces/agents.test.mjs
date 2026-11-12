// Run: node mods/my-spaces/agents.test.mjs
import assert from "node:assert/strict";
import { agentKeys, agentTabs } from "./agents.js";

const keys = agentKeys({ "": [{ key: "claude", agent: true }, { key: "opencode", agent: true }, { key: "nvim", agent: false }] });
assert.deepEqual([...keys].sort(), ["claude", "opencode"]);
assert.equal(agentKeys(undefined).size, 0);

const space = { tabs: [{ id: "a", name: "1", status: "working" }, { id: "b", name: "build", status: null },
  { id: "c", name: "oc", status: null }, { id: "d", name: "empty", status: null }, { id: "e", name: "2agents", status: "blocked" }] };
const ps = [
  { tab: "a", terminal: "t1", program: { key: "claude", agent: true, shell: false } },
  { tab: "b", terminal: "t2", program: { key: "shell", agent: false, shell: true } },       // a plain shell
  { tab: "c", terminal: "t3", program: { key: "opencode", agent: false, shell: false } },   // runs, reports nothing
  { tab: "e", terminal: "t4", program: { key: "pi", agent: true, shell: false } },
  { tab: "e", terminal: "t5", program: { key: "claude", agent: true, shell: false } },
  { tab: "x", terminal: "t6", program: { key: "claude", agent: true, shell: false } },      // another space's tab
  { tab: "d", terminal: null, program: { key: "claude", agent: true } },                    // a mod pane, no terminal
];
const tags = agentTabs(space, ps, keys);
assert.deepEqual(tags.map(t => [t.id, t.program.key, t.status]),
  [["a", "claude", "working"], ["c", "opencode", null], ["e", "pi", "blocked"]]);
assert.deepEqual(agentTabs({ tabs: [] }, ps, keys), []);
assert.deepEqual(agentTabs({}, ps, keys), []);
console.log("agents.test.mjs ok");
