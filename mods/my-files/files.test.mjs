// Run: node files.test.mjs   (stubs the gpui imports so the pure helpers in main.js load in plain Node)
import assert from "node:assert";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./main.js", import.meta.url), "utf8").replace(/^import .*$/gm, "").replace("export default class", "class") + "\nexport { resolveLink, isMarkdown };";
const stub = "const View = class {};\n";
const { resolveLink, isMarkdown } = await import("data:text/javascript;base64," + Buffer.from(stub + src).toString("base64"));

assert.equal(resolveLink("a/b.md", "c.md"), "a/c.md");
assert.equal(resolveLink("a/b.md", "../c.md"), "c.md");
assert.equal(resolveLink("README.md", "docs/./x.md"), "docs/x.md");
assert.equal(resolveLink("a/b.md", "../../x.md"), null); // above the folder: refused, not remapped to x.md
assert.ok(isMarkdown("a/B.MD") && isMarkdown("x.mdx") && !isMarkdown("x.mdc") && !isMarkdown(null));
console.log("ok");
