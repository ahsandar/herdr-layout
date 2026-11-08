// Pure helpers for the Files tree: git's --numstat output, and folder marks/totals built from it.

// "<add>\t<del>\t<path>" entries split by NUL -> { "<top>/<path>": [add, del] }. Binary files ("-") are skipped.
export function parseNumstat(out, top) {
  const counts = {};
  for (const entry of out.split("\0")) {
    const [a, d, ...rest] = entry.split("\t");
    if (rest.length && a !== "-") counts[`${top}/${rest.join("\t")}`] = [Number(a) || 0, Number(d) || 0];
  }
  return counts;
}

// Every folder between `cwd` and a changed file gets a "•" mark and the summed counts. Changes outside `cwd`
// (the git root can sit above the opened folder) are left alone.
export function rollup(marks, counts, cwd) {
  const up = (p, each) => { if (p.startsWith(cwd + "/")) for (let d = p.lastIndexOf("/"); d > cwd.length; d = p.lastIndexOf("/", d - 1)) each(p.slice(0, d)); };
  for (const p of Object.keys(marks)) up(p, (k) => { marks[k] ??= "•"; });
  for (const [p, [a, d]] of Object.entries({ ...counts })) up(p, (k) => { const c = counts[k] ?? [0, 0]; counts[k] = [c[0] + a, c[1] + d]; });
}
