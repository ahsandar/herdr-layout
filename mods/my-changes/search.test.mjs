// Run: node search.test.mjs   (stubs the gpui imports so search.js loads in plain Node)
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = readFileSync(new URL("./search.js", import.meta.url), "utf8").replace(/^import .*$/gm, "");
const stub = "const div = () => {}, h_flex = div, v_flex = div, InputState = { new: () => ({ on() {}, set_value() {}, value: () => \"\", focus() {} }) }, Input = {};\n";
const S = await import("data:text/javascript;base64," + Buffer.from(stub + src).toString("base64"));

// ---- findInLines + splitSpans
const texts = ["foo Foo FOO", "nothing", "a.b a+b"];
assert.deepEqual(S.findInLines(texts, "foo").matches.map((m) => [m.row, m.start]), [[0, 0], [0, 4], [0, 8]]); // smart case: all lower -> any case
assert.deepEqual(S.findInLines(texts, "Foo").matches.map((m) => m.start), [4]);                                // has a capital -> exact
assert.equal(S.findInLines(texts, "foo", { cs: true }).matches.length, 1);                                    // Aa forces exact
assert.equal(S.findInLines(texts, "a.b").matches.length, 1);                                                   // fixed string: . is a dot
assert.equal(S.findInLines(texts, "a.b", { regex: true }).matches.length, 2);
assert.equal(S.findInLines(texts, "(", { regex: true }).error, "Invalid pattern");
assert.equal(S.findInLines(texts, "x*", { regex: true }).matches.length, 0);                                  // empty matches never loop
assert.deepEqual(S.splitSpans([["k", "let x"], ["", " = 1"]], [{ start: 4, end: 7, cur: false }, { start: 8, end: 9, cur: true }]),
  [["k", "let "], ["k", "x", 1], ["", " =", 1], ["", " "], ["", "1", 2]]);                                    // a match across two spans, then the current one
assert.deepEqual(S.splitSpans([["a", "abc"]], []), [["a", "abc"]]);

// ---- fuzzyRank
const files = ["src/main.js", "README.md", "mods/my-files/main.js", "docs/maintenance.md", "lib/other.py"];
assert.equal(S.fuzzyRank("mj", files)[0], "src/main.js");
assert.equal(S.fuzzyRank("readme", files)[0], "README.md");
assert.deepEqual(S.fuzzyRank("zzz", files), []);
assert.deepEqual(S.fuzzyRank("", files), []);
assert.equal(S.fuzzyRank("main", files)[0].endsWith("main.js"), true);

// ---- parsers
assert.deepEqual(S.parseHits("a/b.js\x0012:let x = 1\n./c d:e.md\x003:hi: there\n"), [{ path: "a/b.js", line: 12, text: "let x = 1" }, { path: "c d:e.md", line: 3, text: "hi: there" }]);
assert.deepEqual(S.parseHits("./a.txt:7:text:with:colons\nbad line\n"), [{ path: "a.txt", line: 7, text: "text:with:colons" }]);
assert.deepEqual(S.parseFileList("./a\nb/c\n\n"), ["a", "b/c"]);
assert.deepEqual([...S.parseTranscripts("/x/1.jsonl\0/x/2.jsonl\0")], ["/x/1.jsonl", "/x/2.jsonl"]);

// ---- Finder: navigation, marks, keys, options
{
  const cx = { notify() {}, timer: { after() {} } }, jumps = [];
  let changes = 0;
  const f = new S.Finder("t", { modes: ["Files", "Diff"], onChange: () => { changes++; }, onJump: (m) => jumps.push(m.row) });
  f.setMatches([{ row: 2, start: 0, end: 1 }, { row: 2, start: 4, end: 5 }, { row: 7, start: 1, end: 3 }]);
  assert.deepEqual(f.marks().get(2).map((r) => r.cur), [true, false]);               // exactly one current range
  f.step(-1, cx); assert.equal(f.cur, 2);                                            // wraps back from the first to the last
  f.step(1, cx); assert.equal(f.cur, 0);                                             // and on from the last to the first
  assert.deepEqual(jumps, [7, 2]);
  assert.deepEqual(f.marks().get(7).map((r) => r.cur), [false]);
  f.open = true; f.query = "x";
  assert.equal(f.keyDown({ key: "a", keystroke: "a" }, cx), false);                  // other keys are left alone
  assert.equal(f.keyDown({ key: "enter", keystroke: "shift-enter" }, cx), true); assert.equal(f.cur, 2); // shift-enter steps back
  assert.equal(f.keyDown({ key: "escape", keystroke: "escape" }, cx), true);
  assert.deepEqual([f.open, f.query, f.matches.length], [false, "", 0]);             // escape closes and clears
  assert.equal(f.keyDown({ key: "escape", keystroke: "escape" }, cx), false);        // a closed bar uses no keys
  f.apply({ mode: "Diff", cs: true, regex: true, query: "abc" }, cx);
  assert.deepEqual([f.mode, f.cs, f.regex, f.query], ["Diff", true, true, "abc"]);
  f.apply({ mode: "Nope" }, cx); assert.equal(f.mode, "Diff");                       // an unknown mode is ignored
  assert.ok(changes >= 2);
}

// ---- the scripts, with ripgrep and without (grep fallback). Same folder, same answers.
const dir = mkdtempSync(join(tmpdir(), "search-"));
writeFileSync(join(dir, "a.txt"), "Hello World\nsecond line\n");
mkdirSync(join(dir, "sub")); writeFileSync(join(dir, "sub", "b file.txt"), "no match\nhello again\n");
mkdirSync(join(dir, ".git")); writeFileSync(join(dir, ".git", "x"), "hello in git\n");
mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true }); writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "hello from a library\n"); // not a git repo: no .gitignore to lean on
writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 104, 101, 108, 108, 111]));
const home = join(dir, "home"); mkdirSync(join(home, ".claude", "projects"), { recursive: true });
writeFileSync(join(home, ".claude", "projects", "s1.jsonl"), '{"text":"find the needle"}\n');
writeFileSync(join(home, ".claude", "projects", "s2.jsonl"), '{"text":"nothing"}\n');
const nogrep = join(dir, "bin-no-rg"); mkdirSync(nogrep);
for (const tool of ["grep", "head", "timeout", "sed", "find", "git", "sh"]) {
  try { symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`]).toString().trim(), join(nogrep, tool)); } catch {}
}
const run = (script, args, env) => execFileSync("sh", ["-c", script, "search", ...args], { cwd: dir, env: { HOME: home, ...env }, encoding: "utf8" });
const haveRg = (() => { try { execFileSync("sh", ["-c", "command -v rg"]); return true; } catch { return false; } })();
const variants = [["grep fallback", { PATH: nogrep }], ...(haveRg ? [["ripgrep", { PATH: process.env.PATH }]] : [])];
for (const [name, env] of variants) {
  const hits = S.parseHits(run(S.CONTENT_SCRIPT, S.contentArgs("hello").slice(3), env)).map((h) => `${h.path}:${h.line}`).sort();
  assert.deepEqual(hits, ["a.txt:1", "sub/b file.txt:2"], name);                          // smart case; .git, node_modules and binary files skipped; path with a space
  assert.deepEqual(S.parseHits(run(S.CONTENT_SCRIPT, S.contentArgs("Hello World", { cs: true }).slice(3), env)).map((h) => h.path), ["a.txt"], name);
  assert.deepEqual(S.parseHits(run(S.CONTENT_SCRIPT, S.contentArgs("hel+o", { regex: true }).slice(3), env)).length >= 1, true, name);
  assert.deepEqual(S.parseHits(run(S.CONTENT_SCRIPT, S.contentArgs("-- $(touch pwned) ;").slice(3), env)), [], name); // the query is data, not shell
  assert.deepEqual(S.parseFileList(run(S.FILE_LIST_SCRIPT, [], env)).sort().filter((f) => !f.startsWith("home/") && !f.startsWith("bin-no-rg/")), ["a.txt", "bin.dat", "sub/b file.txt"], name);
  assert.deepEqual([...S.parseTranscripts(run(S.TRANSCRIPT_SCRIPT, S.transcriptArgs("needle").slice(3), env))].map((p) => p.split("/").pop()), ["s1.jsonl"], name);
}
assert.throws(() => readFileSync(join(dir, "pwned")), /ENOENT/);
console.log(`ok (${variants.map((v) => v[0]).join(" + ")})`);
