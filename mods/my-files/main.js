// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, VirtualListScrollHandle } from "gpui-base";
import { READ, profileFor, editorLang, fileRows, diffRows, addedLines, codeView, rowTexts } from "./highlight.js";
import { Finder, findInLines, splitSpans, fuzzyRank, contentArgs, parseHits, parseFileList, FILE_LIST_SCRIPT } from "./search.js";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, shared } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path ?? "");

// Folder-relative path of a link target seen from `file`, or null when it would climb above the folder.
function resolveLink(file, target) {
  const out = [];
  for (const part of [...file.split("/").slice(0, -1), ...target.split("/")]) {
    if (part === "..") { if (!out.length) return null; out.pop(); } else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}
const PER_FOLDER = 500, TOTAL = 5000;
const SHOWN = 200; // search hits drawn at once

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.handle = cx.focus_handle(); this.scroll = VirtualListScrollHandle.new();
    this.tree = new Finder("files-find", { placeholder: "Find files", modes: ["Name", "Content"], onChange: (cx) => this.treeSearch(cx) });
    this.within = new Finder("files-in", { placeholder: "Find in file", onChange: (cx) => this.findInFile(cx), onJump: (m) => this.scroll.scroll_to_item(m.row, "center") });
    this.names = null; this.matchNames = []; this.hits = []; this.searchSeq = 0; this.searchNote = null; this.jumpTo = null;
    this.reqSeen = shared("search.open")?.n;
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.clearTree(); this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {}, counts = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
          // shortcut: no counts before the first commit (no HEAD), when that matters diff --cached too.
          const numstat = await exec("git", ["--no-optional-locks", "diff", "HEAD", "--numstat", "-z", "--no-renames"], { cwd, on }).catch(() => null);
          if (numstat?.code === 0) for (const entry of numstat.stdout.split("\0")) {
            const [a, d, ...rest] = entry.split("\t");
            if (rest.length && a !== "-") counts[`${top.stdout.trim()}/${rest.join("\t")}`] = [Number(a) || 0, Number(d) || 0];
          }
        }
        // A collapsed folder shows a dot when something under it changed.
        for (const p of Object.keys(marks)) for (let d = p.lastIndexOf("/"); d > cwd.length; d = p.lastIndexOf("/", d - 1)) marks[p.slice(0, d)] ??= "•";
        // Folders add up the counts of what is under them.
        for (const [p, [a, d]] of Object.entries({ ...counts })) for (let i = p.lastIndexOf("/"); i > cwd.length; i = p.lastIndexOf("/", i - 1)) { const k = p.slice(0, i), c = counts[k] ?? [0, 0]; counts[k] = [c[0] + a, c[1] + d]; }
        if (!this.current(context)) return;
        this.marks = marks; this.counts = counts; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) { this.loading = false; this.names = null; } if (this.view === "diff" && this.file && this.current(context)) this.showDiff(cx); else if (this.view === "file" && this.file && this.current(context)) this.reloadFile(cx); cx.notify(); }
    });
  }

  // The agent edits the open file: show the new text, only when it differs.
  async reloadFile(cx) {
    const path = this.file, context = this.context;
    try {
      const text = await readTextFile(`${this.root}/${path}`, { on: this.on });
      if (this.file === path && this.current(context) && text !== null && this.text !== null && text !== this.text) this.show(path, cx);
    } catch { /* keep the text on screen */ }
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.tokens = null; this.diff = null; this.view = "file"; this.markdown = null; this.mdSource = false; this.file = path; this.fileError = null; this.text = null; this.resetFind();
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        this.text = text;
        if (isMarkdown(path)) { this.markdown = text.length > 300000 ? text.slice(0, 300000) + "\n\n… (file truncated)" : text; this.mdVersion = (this.mdVersion ?? 0) + 1; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt", native = editorLang(path);
        // Native editor where it is known to highlight; the tokenizer view for the other TIOBE languages.
        if (!native && profileFor(path)) { this.tokens = fileRows(text, path); this.applyPending(cx, path); return; }
        this.code = EditorState.new({ language: native ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        this.applyPending(cx, path);
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // Relative .md links open in this panel (never above the folder); web links in the browser.
  followLink(url, cx) {
    if (/^(https?|mailto):/i.test(url)) {
      const w = window()?.platform;
      exec(w === "windows" ? "explorer" : w === "macos" ? "open" : "xdg-open", [url]).catch(() => null);
      return;
    }
    let target;
    try { target = decodeURI(url.split("#")[0]); } catch { return; }
    if (!target || target.startsWith("/") || !isMarkdown(target)) return;
    const next = resolveLink(this.file, target);
    if (next) { this.show(next, cx); cx.notify(); }
  }

  // The same file in its own pane beside the terminal; that pane re-renders when the file is saved.
  openPane() {
    if (this.file) run("pane.split", { direction: "right", mod: "md-preview", props: { file: `${this.root}/${this.file}`, on: this.on ?? null } });
  }

  // ---- search: file names and file contents (tree), text inside the open file (within)
  clearTree() {
    const f = this.tree;
    f.open = false; f.query = ""; f.input.set_value("");
    this.names = null; this.matchNames = []; this.hits = []; this.searchNote = null; this.searchSeq++;
  }

  resetFind() {
    const f = this.within;
    f.open = false; f.query = ""; f.input.set_value(""); f.setMatches([]); this.searching = false;
  }

  openFind(cx, opts = null) {
    // { file, query }: open that file with the find bar already filled in
    if (opts?.file) { this.jumpTo = { path: opts.file, line: null, query: opts.query ?? "", cs: Boolean(opts.cs), regex: Boolean(opts.regex) }; this.show(opts.file, cx); return; }
    if (this.file && this.fileError) return;
    const f = this.file ? this.within : this.tree;
    f.show(cx);
    if (!this.file) this.ensureNames(cx);
    if (opts) f.apply(opts, cx);
  }

  ensureNames(cx) {
    if (this.names || this.namesBusy || !this.root) return;
    const context = this.context, { root, on } = this;
    this.namesBusy = true;
    cx.spawn(async cx => {
      try { const r = await exec("sh", ["-c", FILE_LIST_SCRIPT], { cwd: root, on }); if (this.current(context)) this.names = parseFileList(r.stdout); }
      catch { if (this.current(context)) this.names = []; }
      finally { this.namesBusy = false; if (this.current(context) && this.tree.mode === "Name") this.treeSearch(cx); }
    });
  }

  treeSearch(cx) {
    const f = this.tree, q = f.query.trim(), seq = ++this.searchSeq;
    this.hits = []; this.matchNames = []; this.searchNote = null; f.error = null;
    if (!q) { cx.notify(); return; }
    if (f.mode === "Name") { this.ensureNames(cx); this.matchNames = fuzzyRank(q, this.names ?? []); cx.notify(); return; }
    f.error = findInLines([""], q, f).error;
    if (f.error) { cx.notify(); return; }
    this.searchNote = "Searching…";
    cx.timer.after(250, cx => { if (seq === this.searchSeq) this.runContent(q, seq, cx); });
    cx.notify();
  }

  runContent(q, seq, cx) {
    const context = this.context, { root, on } = this, f = this.tree;
    cx.spawn(async cx => {
      try {
        const r = await exec("sh", contentArgs(q, f), { cwd: root, on });
        if (seq !== this.searchSeq || !this.current(context)) return;
        this.hits = parseHits(r.stdout).map(h => {
          const text = h.text.trimStart().slice(0, 300), found = findInLines([text], q, f).matches;
          return { ...h, spans: splitSpans([["", text]], found.map(m => ({ start: m.start, end: m.end, cur: false }))) };
        });
        this.searchNote = this.hits.length ? null : "No results";
      } catch { if (seq !== this.searchSeq) return; this.hits = []; this.searchNote = "Search failed or timed out"; }
      cx.notify();
    });
  }

  // A search result opens its file; a content hit also opens the find bar there, at that line.
  openHit(path, hit, cx) {
    const f = this.tree;
    this.jumpTo = hit && f.mode === "Content" ? { path, line: hit.line, query: f.query, cs: f.cs, regex: f.regex } : null;
    this.show(path, cx);
  }

  applyPending(cx, path) {
    const p = this.jumpTo;
    if (!p || p.path !== path) return;
    this.jumpTo = null;
    const f = this.within;
    f.cs = p.cs; f.regex = p.regex; f.open = true; f.query = p.query; f.input.set_value(p.query);
    this.findInFile(cx, p.line === null ? null : p.line - 1); // rows start at line 1
  }

  // Finds in the rows being shown. The native editor can't search or scroll, so while a query is set the
  // file is drawn as rows instead (no selection or folding until the bar closes). line: jump to a row.
  // quiet: a refresh, so keep the current match and the scroll position.
  findInFile(cx, line = null, quiet = false) {
    const f = this.within;
    if (!f.open || !f.query) {
      f.setMatches([]); this.searching = false;
      if (this.code || this.markdown !== null) this.tokens = null;
      cx.notify(); return;
    }
    if (this.view !== "diff" && !this.tokens) { if (this.text === null) return; this.tokens = fileRows(this.text, this.file); }
    const rows = this.view === "diff" ? this.diff?.rows : this.tokens.rows;
    if (!rows) { f.setMatches([]); cx.notify(); return; }
    const r = findInLines(rowTexts(rows), f.query, f);
    f.setMatches(r.matches, r.error, quiet);
    this.searching = true;
    if (!quiet && r.matches.length) {
      f.cur = line === null ? 0 : Math.max(0, r.matches.findIndex(m => m.row === line));
      f.remark(); this.scroll.scroll_to_item(r.matches[f.cur].row, "center");
    }
    cx.notify();
  }

  // Search results: a plain list, capped at SHOWN rows (a virtual list drew nothing in this spot).
  resultsView(t) {
    const f = this.tree, rows = [], hits = this.hits.slice(0, SHOWN);
    if (f.mode === "Name") for (const p of this.matchNames) {
      const i = p.lastIndexOf("/");
      rows.push(h_flex().id(`found-${p}`).h(26).flex_none().px(8).gap(7).items_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.openHit(p, null, cx))
        .child(svg("mods/my-files/file.svg").size(13).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(p.slice(i + 1)))
        .child(div().max_w(180).min_w(0).truncate().text_size(11).text_color(t.dim).child(i > 0 ? p.slice(0, i) : "")));
    } else {
      let last = null;
      for (const h of hits) {
        if (h.path !== last) { last = h.path; rows.push(div().id(`hit-file-${h.path}`).flex_none().px(8).pt(8).pb(2).text_size(11).font_semibold().text_color(t.muted).truncate().child(h.path)); }
        rows.push(h_flex().id(`hit-${h.path}:${h.line}`).h(22).flex_none().pl(14).pr(8).gap(8).items_center().rounded(5).cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.openHit(h.path, h, cx))
          .child(div().w(34).flex_none().text_right().text_size(11).text_color(t.dim).child(String(h.line)))
          .child(h_flex().flex_1().min_w(0).overflow_hidden().text_size(12).children(h.spans.map(([, s, found]) => { const el = div().flex_none().whitespace_nowrap().child(s); return found ? el.bg(t.ansi3 + "55") : el; }))));
      }
    }
    return v_flex().id("files-results").flex_1().min_h(0).overflow_y_scrollbar().p(6)
      .children(rows)
      .when(f.mode === "Content" && this.hits.length > SHOWN, el => el.child(div().p(8).text_size(11).text_color(t.dim).child(`Showing the first ${SHOWN} results: narrow the search to see the rest`)))
      .when(!rows.length, el => el.child(div().p(8).text_size(12).text_color(f.error ? t.ansi1 : t.dim).child(f.error ?? this.searchNote ?? (f.mode === "Name" && !this.names ? "Listing files…" : "No results"))));
  }

  showDiff(cx) {
    const path = this.file, context = this.context, root = this.root, on = this.on;
    if (this.view !== "diff") this.diff = null; // keep the old diff on screen while a refresh runs
    this.view = "diff";
    cx.spawn(async cx => {
      let lines;
      try {
        const r = await exec("git", [...READ, "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
        const all = r.code === 0 ? r.stdout.replace(/\n$/, "").split("\n") : [], first = all.findIndex(l => l.startsWith("@@"));
        if (first >= 0) lines = all.slice(first);
        else if (this.marks[`${root}/${path}`] === "A") {
          const text = await readTextFile(`${root}/${path}`, { on });
          lines = text === null || text.includes("\0") ? ["No text diff available"] : addedLines(text);
        } else lines = ["No text diff available"];
      } catch { lines = ["Cannot preview this diff (too large or unreadable)"]; }
      if (this.file === path && this.view === "diff" && this.current(context)) { this.diff = diffRows(lines, path); if (this.within.open) this.findInFile(cx, null, true); }
      cx.notify();
    });
    cx.notify();
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`], count = this.counts?.[`${this.root}/${path}`];
      const color = mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.ansi3;
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/my-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/my-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().when(Boolean(mark), el => el.text_color(color)).child(entry.name))
        .when(Boolean(count?.[0]), el => el.child(div().text_size(11).text_color(t.ansi2).child(`+${count[0]}`)))
        .when(Boolean(count?.[1]), el => el.child(div().text_size(11).text_color(t.ansi1).child(`−${count[1]}`)))
        .when(Boolean(mark), el => el.child(div().w(10).text_size(11).text_color(color).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    // The search key (my-tabs) names the open panel; only that panel opens its bar.
    // Opening a bar notifies, which render may not do: so it runs from a timer.
    const req = shared("search.open");
    if (req && req.n !== this.reqSeen) { this.reqSeen = req.n; if (req.panel === "files") cx.timer.after(0, cx => this.openFind(cx, req.opts)); }
    const t = theme(), find = { handle: this.scroll, marks: this.within.open && this.within.query ? this.within.marks() : null };
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => { if ((this.file ? this.within : this.tree).keyDown(e, cx)) cx.stop_propagation(); })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .child(div().id("files-find-button").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.openFind(cx)).child(svg("mods/my-tabs/search.svg").size(14)))
        .when(Boolean(this.file), el => {
          const md = isMarkdown(this.file), changed = Boolean(this.marks[`${this.root}/${this.file}`]), inFile = this.view === "file";
          const chip = (id, label, on, action) => div().id(id).px(7).py(2).rounded(5).text_size(11).cursor_pointer().when(on, e => e.bg(t.selected)).hover(e => e.bg(t.hover))
            .text_color(on ? t.foreground : t.muted).on_click(action).child(label);
          const file = source => (_e, cx) => { this.mdSource = source; this.view = "file"; if (this.within.open) this.findInFile(cx); cx.notify(); };
          return el.children([
            ...(md ? [chip("files-md-preview", "Preview", inFile && !this.mdSource, file(false)), chip("files-md-source", "Source", inFile && this.mdSource, file(true))]
              : changed ? [chip("files-view-file", "File", inFile, file(false))] : []),
            ...(changed ? [chip("files-view-diff", "Diff", !inFile, (_e, cx) => { if (inFile) this.showDiff(cx); })] : []),
            ...(md ? [chip("files-md-pane", "↗", false, () => this.openPane())] : []),
          ]);
        }))
      .when(!this.file && this.tree.open, el => el.child(this.tree.bar(t, { nav: false, options: this.tree.mode === "Content",
        trailing: this.tree.query.trim() ? div().text_size(11).text_color(t.dim).child(this.tree.mode === "Name" ? `${this.matchNames.length} files` : this.hits.length ? `${Math.min(this.hits.length, SHOWN)}${this.hits.length > SHOWN || this.hits.length >= 500 ? "+" : ""} results` : "") : null })))
      .when(Boolean(this.file) && this.within.open, el => el.child(this.within.bar(t)))
      .when(!this.file && this.tree.open && Boolean(this.tree.query.trim()), el => el.child(this.resultsView(t)))
      .when(!this.file && !(this.tree.open && this.tree.query.trim()), el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(
        this.view === "diff" ? (this.diff ? codeView("files-diff", this.diff, t, settings().font_family, 12, find) : div().p(12).text_color(t.dim).child("Loading diff…"))
        : this.searching && this.tokens ? codeView("files-code", this.tokens, t, settings().font_family, 12, find)
        : this.markdown !== null && !this.mdSource ? div().id("files-md-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12)
          .child(TextView.markdown(`files-md-${this.mdVersion}`, this.markdown).selectable().on_link_click((url, cx) => this.followLink(url, cx)))
        : this.tokens ? codeView("files-code", this.tokens, t, settings().font_family, 12, find)
        : this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
