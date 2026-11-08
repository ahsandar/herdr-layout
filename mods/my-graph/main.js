// Git graph of the focused pane's repo, drawn from `git-graph` (https://github.com/mlange-42/git-graph).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, InputState, Input, VirtualListScrollHandle } from "gpui-base";
import { Finder, findInLines, splitSpans } from "./search.js";
import { spaces, panes, focused, exec, theme, settings, layout, shared } from "herdr";

const MAX = 500;
// Reads write nothing under .git, so polling can't feed itself.
const READ = ["--literal-pathspecs", "--no-optional-locks", "-c", "core.fsmonitor=false"];

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

// True when `child` is the open panel: timers keep running while a panel is hidden, so they check this first.
const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).reduce((hit, c) => hit ?? find(c, id), null));
function visible(child) {
  const root = layout(), panel = find(root, "panel");
  return Boolean(panel && !panel.hidden && find(root, "panel-body")?.active === child);
}

// Herdr runs programs with a different PATH than your shell, so a tool installed through asdf or cargo
// may only be reachable by its full path. Ask sh once per machine; no hit is not cached, so installing it later works.
// shortcut: asdf rust versions are compared with sort -V and the newest wins; set the path by hand if that is wrong.
const FIND = 'command -v git-graph || for p in "$HOME/.cargo/bin/git-graph" "$HOME"/.asdf/installs/rust/*/bin/git-graph; do [ -x "$p" ] && echo "$p"; done | sort -V | tail -1';
const bins = new Map();
async function gitGraph(cwd, on) {
  if (!bins.has(on ?? "")) {
    const r = await exec("sh", ["-c", FIND], { cwd, on });
    const path = r.stdout.trim();
    if (!path) throw new Error("git-graph not found (looked in PATH, ~/.cargo/bin and ~/.asdf/installs/rust/*/bin)");
    bins.set(on ?? "", path);
  }
  return bins.get(on ?? "");
}

// ANSI colours in git-graph's output -> [[color, text]]; color is null, 0..255 or [r, g, b].
const SGR = /\x1b\[([\d;]*)m/g;
function ansi(line) {
  const spans = []; let color = null, last = 0, m;
  const add = (s) => { if (s) spans.push([color, s]); };
  SGR.lastIndex = 0;
  while ((m = SGR.exec(line))) {
    add(line.slice(last, m.index)); last = SGR.lastIndex;
    const p = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0 || c === 39) color = null;
      else if (c >= 30 && c <= 37) color = c - 30;
      else if (c >= 90 && c <= 97) color = c - 82;
      else if (c === 38 && p[i + 1] === 5) { color = p[i + 2]; i += 2; }
      else if (c === 38 && p[i + 1] === 2) { color = [p[i + 2], p[i + 3], p[i + 4]]; i += 4; }
    }
  }
  add(line.slice(last));
  return spans;
}
const hex = (r, g, b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
const CUBE = [0, 95, 135, 175, 215, 255];
function paint(c, t) {
  if (c === null) return null;
  if (Array.isArray(c)) return hex(...c);
  if (c < 16) return t[`ansi${c}`];
  if (c < 232) { const v = c - 16; return hex(CUBE[Math.floor(v / 36)], CUBE[Math.floor(v / 6) % 6], CUBE[v % 6]); }
  const g = 8 + 10 * (c - 232);
  return hex(g, g, g);
}

// Branch names from `for-each-ref --format=%(refname) refs/heads refs/remotes`; origin/HEAD is not a branch.
function parseBranches(out) {
  return out.split("\n").filter((n) => n && !n.endsWith("/HEAD"))
    .map((n) => n.startsWith("refs/heads/") ? { name: n.slice(11), remote: false } : { name: n.slice(13), remote: true });
}

// git-graph ignores branch names unless a model is given with -m, so a filter always passes one.
// shortcut: "simple" for filtered views, so a repo's own git-flow model is not applied there.
function graphArgs(picked, local) {
  return ["--color", "always", "--wrap", "none", "-n", String(MAX), ...(picked.length ? ["-m", "simple"] : []), ...(local ? ["--local"] : []), ...picked];
}

export default class Graph extends View {
  init(_props, cx) {
    this.rows = []; this.width = 300; this.sig = null; this.dirty = 0;
    this.handle = cx.focus_handle(); this.scroll = VirtualListScrollHandle.new(); this.reqSeen = shared("search.open")?.n;
    // Finds text in the commit lines shown (hash, refs, subject), highlights it and jumps to it.
    this.find = new Finder("graph-find", { placeholder: "Find in graph", onChange: (cx) => this.search(cx), onJump: (m) => this.scroll.scroll_to_item(m.row, "center") });
    this.texts = [];
    this.branches = []; this.current = null; this.sel = new Set(); this.local = false; this.open = false; this.filter = "";
    this.input = InputState.new({ placeholder: "Filter branches" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value().trim().toLowerCase(); cx.notify(); });
    this.refresh(cx);
    // shortcut: polls every 3s because the folder watch skips .git on Linux; use watchFolder if that changes.
    cx.timer.every(3000, (cx) => this.refresh(cx));
  }

  // The branch choice is remembered per folder and machine.
  restore(context) {
    this.sel = new Set(); this.local = false;
    try { const v = JSON.parse(localStorage.getItem(`graph:${context}`) ?? "null"); if (v) { this.sel = new Set(v.sel); this.local = Boolean(v.local); } } catch {}
  }

  save() { try { localStorage.setItem(`graph:${this.context}`, JSON.stringify({ sel: [...this.sel], local: this.local })); } catch {} }

  choose(name, cx) {
    if (name === null) this.sel.clear(); else if (this.sel.has(name)) this.sel.delete(name); else this.sel.add(name);
    this.save(); this.sig = null; this.refresh(cx, true); cx.notify();
  }

  // Matches of the find query in the lines shown. quiet: the graph was redrawn, so keep the current match.
  refind(quiet = false) {
    const f = this.find;
    if (!f.open || !f.query) { f.setMatches([]); return; }
    const r = findInLines(this.texts, f.query, f);
    f.setMatches(r.matches, r.error, quiet);
    if (!quiet && r.matches.length) { f.remark(); this.scroll.scroll_to_item(r.matches[0].row, "center"); }
  }

  search(cx) { this.refind(); cx.notify(); }

  // What the tab shows, as one string, to tell whether a poll changed anything.
  shown() { return [this.sig, this.error, this.dirty, this.current, this.rows.length, this.branches.map((b) => b.name).join(",")].join("|"); }

  refresh(cx, force = false) {
    if (this.loading) { if (force) this.again = true; return; }
    const { cwd, on } = location(), context = key(), before = this.shown();
    if (context !== this.context) { this.context = context; this.rows = []; this.sig = null; this.error = null; this.dirty = 0; this.branches = []; this.current = null; this.restore(context); }
    // The timer does nothing while the tab is closed; opening it (see render) or a click refreshes at once.
    if (!cwd || (!force && !visible("graph"))) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", [...READ, ...args], { cwd, on });
        // Cheap check first: every ref plus HEAD plus the count of changed files. Only a change redraws the graph.
        const [refs, head, status, names, cur] = await Promise.all([git(["for-each-ref", "--format=%(objectname) %(refname)"]), git(["rev-parse", "HEAD"]), git(["status", "--porcelain=v1", "-z"]),
          git(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]), git(["symbolic-ref", "--short", "-q", "HEAD"])]);
        if (key() !== context) return;
        if (status.code !== 0) { this.rows = []; this.sig = null; this.error = "Not a git repository"; return; }
        const dirty = status.stdout.split("\0").filter(Boolean).length;
        // A failed listing keeps the last list and the picked branches as they were.
        if (names.code === 0) {
          this.branches = parseBranches(names.stdout);
          this.current = cur.code === 0 ? cur.stdout.trim() : null;
          // A branch that was deleted since it was picked drops out of the choice.
          for (const n of this.sel) if (!this.branches.some((b) => b.name === n)) this.sel.delete(n);
        }
        const picked = [...this.sel].sort(), sig = refs.stdout + head.stdout + picked.join(",") + this.local;
        this.dirty = dirty;
        if (sig === this.sig && !this.error) return;
        const r = await exec(await gitGraph(cwd, on), graphArgs(picked, this.local), { cwd, on });
        if (key() !== context) return;
        if (r.code !== 0) { this.error = (r.stderr || r.stdout).trim().split("\n")[0] || "git-graph failed"; return; }
        const lines = r.stdout.replace(/\n$/, "").split("\n");
        this.rows = lines.map(ansi);
        this.texts = this.rows.map((spans) => spans.map((s) => s[1]).join(""));
        this.refind(true);
        this.width = Math.max(300, ...lines.map((l) => l.replace(/\x1b\[[\d;]*m/g, "").length * 8 + 30));
        this.sig = sig; this.error = null;
      } catch (e) {
        this.error = String(e).replace(/^Error: /, "");
      } finally {
        this.loading = false;
        if (this.again) { this.again = false; this.refresh(cx, true); }
        // Redraw only when something on screen changed: every redraw repaints the whole window.
        if (force || this.shown() !== before) cx.notify();
      }
    });
  }

  filterPanel(t) {
    const list = this.branches.filter((b) => !(this.local && b.remote) && b.name.toLowerCase().includes(this.filter))
      .sort((a, b) => (b.name === this.current) - (a.name === this.current) || a.remote - b.remote || a.name.localeCompare(b.name)).slice(0, 300);
    const chip = (id, text, on, run) => div().id(id).h(24).px(8).flex().items_center().rounded(6).border_1().border_color(on ? t.accent : t.border).text_size(11).text_color(on ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(run).child(text);
    return v_flex().flex_none().p(8).gap(6).border_b(1).border_color(t.border)
      .child(div().id("graph-branch-filter").h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(6)
        .child(chip("graph-all", "All", this.sel.size === 0, (_e, cx) => this.choose(null, cx)))
        .child(chip("graph-local", "Local only", this.local, (_e, cx) => { this.local = !this.local; this.save(); this.sig = null; this.refresh(cx, true); cx.notify(); }))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.dim).child(`latest ${MAX} commits`)))
      .child(v_flex().id("graph-branches").h(Math.min(200, Math.max(30, list.length * 26 + 4))).overflow_y_scrollbar().children(list.map((b) =>
        h_flex().id(`graph-branch-${b.remote ? "r" : "l"}-${b.name}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().when(this.sel.has(b.name), (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.choose(b.name, cx))
          .child(div().w(12).flex_none().text_color(t.accent).child(this.sel.has(b.name) ? "✓" : ""))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(b.remote ? t.muted : t.foreground).child(b.name))
          .when(b.name === this.current, (e) => e.child(div().text_size(10).text_color(t.dim).child("HEAD"))))))
      .when(!list.length, (e) => e.child(div().px(8).text_size(12).text_color(t.dim).child(this.branches.length ? "No matching branch" : "No branches")));
  }

  render(cx) {
    const shown = visible("graph");
    if (shown && !this.wasShown) this.refresh(cx);
    this.wasShown = shown;
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), ff = settings().font_family ?? "JetBrains Mono";
    const label = this.sel.size === 1 ? [...this.sel][0] : this.sel.size ? `${this.sel.size} branches` : this.local ? "Local branches" : "All branches";
    // Opening a bar notifies, which render may not do: so it runs from a timer.
    const req = shared("search.open");
    if (req && req.n !== this.reqSeen) { this.reqSeen = req.n; if (req.panel === "graph") cx.timer.after(0, (cx) => { this.find.show(cx); if (req.opts) this.find.apply(req.opts, cx); }); }
    const marks = this.find.open && this.find.query ? this.find.marks() : null;
    // found: 1 is a search match, 2 the current one (search.js splitSpans); split first, paint each piece after.
    const row = (spans) => h_flex().w_full().h(20).flex_none().px(10).children(spans.map(([c, s, found]) => {
      const el = div().flex_none().whitespace_nowrap().child(s), col = paint(c, t), coloured = col ? el.text_color(col) : el;
      return found ? coloured.bg(found === 2 ? t.accent + "99" : t.ansi3 + "55") : coloured;
    }));
    return v_flex().id("graph").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => { if (this.find.keyDown(e, cx)) cx.stop_propagation(); })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Graph"))
        .when(this.dirty > 0, (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.blocked).child(`${this.dirty} uncommitted`)))
        .child(div().flex_1())
        .child(div().id("graph-find-button").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.find.show(cx)).child(svg("mods/my-tabs/search.svg").size(14)))
        .child(div().id("graph-branch-button").max_w(190).h(24).px(8).flex().items_center().gap(4).rounded(6).border_1().border_color(this.open ? t.accent : t.border).cursor_pointer().text_size(11).text_color(this.sel.size || this.local ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.open = !this.open; cx.notify(); })
          .child(div().min_w(0).truncate().child(label)).child(div().text_color(t.dim).child(this.open ? "▴" : "▾"))))
      .when(this.find.open, (el) => el.child(this.find.bar(t, { options: true })))
      .when(this.open, (el) => el.child(this.filterPanel(t)))
      .child(div().flex_1().min_h(0).relative().font_family(ff).text_size(12)
        .child(div().id("graph-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.width).h_full().child(v_virtual_list("graph-list", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((spans, k) => row(marks?.has(range.start + k) ? splitSpans(spans, marks.get(range.start + k)) : spans))).size_full().track_scroll(this.scroll))))
        .child(Scrollbar.vertical("graph-list").viewport_from_layout().absolute().inset_0())
        .when(!this.rows.length, (e) => e.child(div().absolute().top(8).px(12).text_color(t.dim).child(this.error || (this.loading ? "Loading graph…" : "No commits")))));
  }
}
