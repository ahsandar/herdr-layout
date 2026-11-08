// Run: node highlight.test.mjs   (strips the gpui imports so highlight.js loads in plain Node)
import assert from "node:assert";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./highlight.js", import.meta.url), "utf8").replace(/^import .*$/gm, "");
const { tokenize, profileFor, diffRows, fileRows, editorLang } = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
const spans = (path, line, st) => tokenize(line, profileFor(path), st).spans;
const cls = (path, line) => spans(path, line).map(([k, s]) => `${k}:${s}`).join("|");

assert.equal(cls("a.py", "def foo(x): # hi"), "k:def|: |f:foo|:(x): |c:# hi");
assert.ok(cls("a.rs", 'let s = "a//b"; // c').includes('s:"a//b"') && cls("a.rs", 'let s = "a//b"; // c').endsWith("c:// c"));
assert.ok(cls("a.sql", "SELECT 1 -- x").startsWith("k:SELECT"));
assert.ok(cls("a.cob", "      * note").startsWith("c:"));
assert.ok(cls("a.cbl", "*> hi").startsWith("c:"));
assert.ok(cls("a.hs", "x = 1 {- a -} y").includes("c:{- a -}"));
assert.ok(cls("a.c", "#include <x>").startsWith("k:#include"));
assert.equal(profileFor("a.unknownext"), undefined);

// ' is not a string quote in Rust, MATLAB, Julia, Ada
for (const [f, l] of [["a.rs", "fn f<'a>(x: &'a str) {}"], ["a.matlab", "y = A' * B;"], ["a.jl", "y = A' * B"], ["a.adb", "N : Integer := A'Length;"]])
  assert.ok(!spans(f, l).some(([k]) => k === "s"), f);
// PHP #[Attribute] is not a comment
assert.ok(!spans("a.php", "#[Attribute] class A {}").some(([k]) => k === "c"));

// block-comment state carries within a hunk, old and new sides tracked separately
const d = diffRows(["@@ -1,3 +1,3 @@", "+/* start", "+ still", "+ end */ int x;"], "a.c");
assert.equal(d.rows[2].spans[0][0], "c"); assert.ok(d.rows[3].spans.some(([k, s]) => k === "k" && s === "int"));
const e = diffRows(["@@ -1,2 +1,2 @@", "-/* old", "+int y;", "-x */"], "a.c");
assert.ok(e.rows[2].spans.some(([k]) => k === "k"));

// CRLF: no trailing \r in the text
assert.equal(diffRows(["@@ -1 +1 @@", "+int x;\r"], "a.c").rows[1].spans.map(([, s]) => s).join(""), "int x;");

// long files say they were cut
assert.equal(fileRows("x\n".repeat(7000), "a.py").rows.at(-1).spans[0][1], "… (file truncated)");
assert.equal(fileRows("x\n".repeat(10), "a.py").rows.length, 10);
assert.equal(fileRows("a\nb\n", "a.py").rows[1].number, 2); // no header row: row 1 is line 2
assert.equal(fileRows("x".repeat(400001), "a.py").rows.at(-1).spans[0][1], "… (file truncated)");

assert.equal(editorLang("a.py"), "py"); assert.equal(editorLang("a.cob"), null);
for (const x of ["c","cpp","java","cs","js","ts","py","r","sql","vb","go","rs","php","f90","pl","asm","swift","pas","dart","cob","abap","sas","rb","pro","lua","kt","ml","sml","d","lisp","clj","scala","hs","gml","prg","xsl","sol","adb","jl","ex","m","vbs","tsql"]) assert.ok(profileFor("f." + x), x);
console.log("ok");
