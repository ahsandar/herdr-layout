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
console.log("ok");
