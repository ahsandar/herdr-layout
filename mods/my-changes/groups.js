// Which kind of change each file in the Changes list is, and the pure helpers around git's output.
// A file can have several: "unpushed" (in commits no remote has) and "uncommitted" (edited since) make "recommit".
export const FILTERS = ["all", "uncommitted", "untracked", "unpushed", "recommit"];
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // diff base when the oldest unpushed commit is the root

export function inFilter(f, name) {
  switch (name) {
    case "all": return true;
    case "untracked": return Boolean(f.fresh);
    case "uncommitted": return Boolean(f.dirty && !f.fresh);
    case "unpushed": return Boolean(f.unpushed);
    case "recommit": return Boolean(f.unpushed && f.dirty && !f.fresh);
  }
  return false;
}
export const tagsOf = (f) => FILTERS.filter((name) => name !== "all" && inFilter(f, name));

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
// Returns how many it had to leave out.
export function mergeUnpushed(files, letters, stats, limit) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  let dropped = 0;
  for (const [path, letter] of letters) {
    const known = byPath.get(path);
    if (known) known.unpushed = true;
    else if (files.length < limit) files.push({ path, status: letter, fresh: false, dirty: false, unpushed: true, add: 0, del: 0, ...stats[path] });
    else dropped++;
  }
  return dropped;
}

// What counts as unpushed: commits no remote-tracking branch has. Returns { base, note }: `base` is the commit
// before the oldest of them (diff base .. HEAD is everything unpushed), or null with a note saying why not.
// `git` is async (args) => { code, stdout } run in the repo.
export async function unpushedBase(git, hasHead) {
  if (!hasHead) return { base: null, note: "No commits yet" };
  const remotes = await git(["remote"]);
  if (remotes.code !== 0 || !remotes.stdout.trim()) return { base: null, note: "No remote, so nothing counts as unpushed" };
  const revs = await git(["rev-list", "--topo-order", "HEAD", "--not", "--remotes"]);
  const oldest = revs.code === 0 ? revs.stdout.trim().split("\n").pop() : "";
  if (!oldest) return { base: null, note: null };
  const parent = await git(["rev-parse", "--verify", "-q", `${oldest}^`]);
  return { base: parent.code === 0 ? parent.stdout.trim() : EMPTY_TREE, note: null };
}
