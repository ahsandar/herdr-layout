// Run: node rollup.test.mjs
import assert from "node:assert";
import { parseNumstat, rollup } from "./rollup.js";

// numstat: tab inside a path survives, binary files have no counts, the empty tail entry is ignored.
assert.deepEqual(parseNumstat("3\t1\tsrc/a.js\0-\t-\timg.png\0\x32\t0\ta\tb.txt\0", "/r"), { "/r/src/a.js": [3, 1], "/r/a\tb.txt": [2, 0] });
assert.deepEqual(parseNumstat("", "/r"), {});

// Opened folder /r/app below the git root /r: folders between it and each file get a dot and the sums.
const marks = { "/r/app/lib/x/a.ex": "M", "/r/app/lib/b.ex": "A", "/r/other/c.ex": "M", "/r/app/top.ex": "M" };
const counts = { "/r/app/lib/x/a.ex": [3, 1], "/r/app/lib/b.ex": [2, 0], "/r/other/c.ex": [9, 9] };
rollup(marks, counts, "/r/app");
assert.equal(marks["/r/app/lib"], "•"); assert.equal(marks["/r/app/lib/x"], "•");
assert.deepEqual(counts["/r/app/lib"], [5, 1]); assert.deepEqual(counts["/r/app/lib/x"], [3, 1]);
assert.equal(marks["/r/app"], undefined);   // the opened folder itself is not a row
assert.equal(marks["/r/other"], undefined); assert.equal(counts["/r/other"], undefined); // outside the opened folder
assert.equal(marks["/r/app/lib/b.ex"], "A"); // a real mark is never overwritten
console.log("ok");
