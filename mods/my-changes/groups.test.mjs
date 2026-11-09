// Run: node groups.test.mjs
import assert from "node:assert";
import { tagsOf, inFilter, numstatMap, parseNameStatus, mergeUnpushed } from "./groups.js";

assert.deepEqual(tagsOf({ dirty: true }), ["uncommitted"]);
assert.deepEqual(tagsOf({ dirty: true, fresh: true }), ["untracked"]);
assert.deepEqual(tagsOf({ unpushed: true }), ["unpushed"]);
assert.deepEqual(tagsOf({ dirty: true, unpushed: true }), ["uncommitted", "unpushed", "recommit"]);
assert.ok(inFilter({ dirty: true, unpushed: true }, "recommit") && !inFilter({ unpushed: true }, "recommit") && inFilter({}, "all"));

// numstat: outputs add up, binary files keep their flag, a tab in a path survives.
assert.deepEqual(numstatMap(["1\t2\ta\0-\t-\tb\0", "3\t0\ta\0", "4\t4\tx\ty\0"]),
  { a: { add: 4, del: 2, binary: false }, b: { add: 0, del: 0, binary: true }, "x\ty": { add: 4, del: 4, binary: false } });
assert.deepEqual([...parseNameStatus("M\0a.js\0A\0b.js\0D\0c.js\0T\0d.js\0")], [["a.js", "M"], ["b.js", "A"], ["c.js", "D"], ["d.js", "M"]]);

// merge: a file edited since it was committed is flagged, committed-only files are added with their own counts, limit holds.
const files = [{ path: "a.js", status: "M", dirty: true, add: 1, del: 0 }];
mergeUnpushed(files, new Map([["a.js", "M"], ["b.js", "A"], ["c.js", "M"]]), { "b.js": { add: 5, del: 0, binary: false } }, 2);
assert.equal(files[0].unpushed, true);
assert.deepEqual(files[1], { path: "b.js", status: "A", fresh: false, dirty: false, unpushed: true, add: 5, del: 0, binary: false });
assert.equal(files.length, 2); // c.js dropped by the limit

// unpushedBase against real repos: no commits, no remote, never pushed (root commit), pushed, one commit ahead.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpushedBase, EMPTY_TREE } from "./groups.js";
const dir = mkdtempSync(join(tmpdir(), "unpushed-")), env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const run = (args, cwd = join(dir, "w")) => { const r = spawnSync("git", args, { cwd, env, encoding: "utf8" }); return { code: r.status, stdout: r.stdout }; };
const commit = (name) => { writeFileSync(join(dir, "w", name), name); run(["add", name]); run(["commit", "-qm", name]); };
try {
  run(["init", "-q", "w"], dir); run(["init", "-q", "--bare", "r.git"], dir);
  assert.deepEqual(await unpushedBase(run, false), { base: null, note: "No commits yet" });
  commit("one");
  assert.match((await unpushedBase(run, true)).note, /No remote/);
  run(["remote", "add", "origin", "../r.git"]);
  assert.deepEqual(await unpushedBase(run, true), { base: EMPTY_TREE, note: null }); // nothing pushed: all of it, from the root
  run(["push", "-q", "origin", "HEAD:main"]);
  assert.deepEqual(await unpushedBase(run, true), { base: null, note: null });         // fully pushed
  const pushed = run(["rev-parse", "HEAD"]).stdout.trim();
  commit("two"); commit("three");
  assert.deepEqual(await unpushedBase(run, true), { base: pushed, note: null });       // two commits ahead: diff from the pushed one
} finally { rmSync(dir, { recursive: true, force: true }); }

// mergeUnpushed reports what the limit cut.
assert.equal(mergeUnpushed([], new Map([["a", "M"], ["b", "M"], ["c", "M"]]), {}, 2), 1);
console.log("ok");
