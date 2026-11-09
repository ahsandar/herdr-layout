// Which kind of change each file in the Changes list is, and the pure helpers around git's output.
// A file can have several: "unpushed" (in commits no remote has) and "uncommitted" (edited since) make "recommit".
export const FILTERS = ["all", "uncommitted", "untracked", "unpushed", "recommit"];
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // diff base when the oldest unpushed commit is the root

export function tagsOf(f) {
  const tags = [];
  if (f.fresh) tags.push("untracked"); else if (f.dirty) tags.push("uncommitted");
  if (f.unpushed) tags.push("unpushed");
  if (f.unpushed && f.dirty && !f.fresh) tags.push("recommit");
  return tags;
}
export const inFilter = (f, name) => name === "all" || tagsOf(f).includes(name);

// git diff --numstat -z outputs ("<add>\t<del>\t<path>" split by NUL) -> { path: { add, del, binary } }. Outputs add up.
export function numstatMap(outputs) {
  const stats = {};
  for (const out of outputs) for (const entry of out.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
    stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
  }
  return stats;
}

// git diff --name-status -z --no-renames output ("M\0path\0A\0path\0") -> Map(path -> "A" | "D" | "M")
export function parseNameStatus(out) {
  const letters = new Map(), p = out.split("\0");
  for (let i = 0; i + 1 < p.length; i += 2) letters.set(p[i + 1], p[i][0] === "A" || p[i][0] === "D" ? p[i][0] : "M");
  return letters;
}

// Flags files already listed and appends the ones that only exist in unpushed commits (stopping at `limit` files).
export function mergeUnpushed(files, letters, stats, limit) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const [path, letter] of letters) {
    const known = byPath.get(path);
    if (known) known.unpushed = true;
    else if (files.length < limit) files.push({ path, status: letter, fresh: false, dirty: false, unpushed: true, add: 0, del: 0, ...stats[path] });
  }
  return files;
}
