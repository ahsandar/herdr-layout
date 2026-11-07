// Run: node graph.test.mjs   (stubs the gpui imports so the ANSI parser loads in plain Node)
import assert from "node:assert";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./main.js", import.meta.url), "utf8").replace(/^import .*$/gm, "").replace("export default class", "class")
  + "\nexport { ansi, paint, parseBranches, graphArgs };";
const stub = "const View = class {}, div = () => {}, v_flex = div, h_flex = div, Scrollbar = {}, v_virtual_list = div, spaces = div, panes = div, focused = div, exec = div, theme = div, settings = div;\n";
const { ansi, paint, parseBranches, graphArgs } = await import("data:text/javascript;base64," + Buffer.from(stub + src).toString("base64"));

assert.deepEqual(ansi("\x1b[38;5;12m●\x1b[0m x \x1b[38;5;11m971d45c\x1b[0m"), [[12, "●"], [null, " x "], [11, "971d45c"]]);
assert.deepEqual(ansi("\x1b[91mred\x1b[39m\x1b[38;2;1;2;3mrgb\x1b[m!"), [[9, "red"], [[1, 2, 3], "rgb"], [null, "!"]]);
assert.deepEqual(ansi("plain"), [[null, "plain"]]);
const t = { ansi5: "#a0a" };
assert.equal(paint(5, t), "#a0a"); assert.equal(paint(null, t), null);
assert.equal(paint(196, t), "#ff0000"); assert.equal(paint(232, t), "#080808"); assert.equal(paint([1, 2, 3], t), "#010203");

assert.deepEqual(parseBranches("refs/heads/main\nrefs/heads/feat/x\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\n"),
  [{ name: "main", remote: false }, { name: "feat/x", remote: false }, { name: "origin/main", remote: true }]);
// no filter: no -m (keeps the repo's own model); a filter always carries -m, or git-graph ignores the names
assert.ok(!graphArgs([], false).includes("-m"));
const f = graphArgs(["a", "b"], true);
assert.deepEqual(f.slice(-5), ["-m", "simple", "--local", "a", "b"]);
console.log("ok");
