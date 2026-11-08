// Search shared by the panel mods (my-files, my-changes, my-graph, history): a find bar, text matching,
// fuzzy file names, and the ripgrep (grep when it is missing) scripts. Keep the four copies identical.
// shortcut: local folders only; regex means ripgrep/grep syntax for content and JS syntax for in-file find.
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";

// ---------------------------------------------------------------- matching

// Smart case: all-lowercase queries ignore case, unless "Aa" forces it.
const ignoreCase = (query, cs) => !cs && query === query.toLowerCase();

// Matches of `query` in each text: { matches: [{row, start, end}], error }. Capped at `cap`.
export function findInLines(texts, query, { cs = false, regex = false } = {}, cap = 5000) {
  if (!query) return { matches: [], error: null };
  let re;
  try { re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase(query, cs) ? "gi" : "g"); }
  catch { return { matches: [], error: "Invalid pattern" }; }
  const matches = [];
  for (let row = 0; row < texts.length && matches.length < cap; row++) {
    const text = texts[row];
    if (!text) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && matches.length < cap) {
      if (!m[0].length) { re.lastIndex++; continue; }
      matches.push({ row, start: m.index, end: m.index + m[0].length });
    }
  }
  return { matches, error: null };
}

// Splits [[tag, text]] around `ranges` ({start, end, cur}, sorted, in the joined text's offsets) into
// [[tag, text, flag]]: flag 1 is a match, 2 the current one. The tag is kept, so any row kind works.
export function splitSpans(spans, ranges) {
  const out = []; let off = 0, r = 0;
  for (const [tag, text] of spans) {
    const end = off + text.length;
    let i = 0;
    while (i < text.length) {
      while (r < ranges.length && ranges[r].end <= off + i) r++;
      const m = ranges[r];
      if (!m || m.start >= end) { out.push([tag, text.slice(i)]); break; }
      if (m.start > off + i) { out.push([tag, text.slice(i, m.start - off)]); i = m.start - off; }
      const stop = Math.min(m.end, end) - off;
      out.push([tag, text.slice(i, stop), m.cur ? 2 : 1]); i = stop;
    }
    off = end;
  }
  return out;
}

// Paths that contain the query's letters in order, best first. Bonuses: letters together, at the start of a
// word, in the file name. Empty query: nothing.
export function fuzzyRank(query, paths, limit = 200) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const path of paths) {
    const p = path.toLowerCase(), base = p.lastIndexOf("/") + 1;
    let qi = 0, score = 0, prev = -2;
    for (let i = 0; i < p.length && qi < q.length; i++) {
      if (p[i] !== q[qi]) continue;
      score += 1 + (i === prev + 1 ? 4 : 0) + (i === 0 || "/._- ".includes(p[i - 1]) ? 3 : 0) + (i >= base ? 2 : 0);
      prev = i; qi++;
    }
    if (qi === q.length) scored.push([score - p.length * 0.05 + (p.slice(base).includes(q) ? 20 : 0), path]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map((s) => s[1]);
}

// ---------------------------------------------------------------- ripgrep / grep

// Run through `sh -c SCRIPT search QUERY MODE CASE`; the query is an argument, never part of the script.
// ripgrep is used when found (PATH, then ~/.cargo/bin), otherwise grep. Output is capped by `head`
// (which also stops the search early) and by `timeout`, because exec allows 30 s and 8 MiB.
const FIND_RG = 'RG=$(command -v rg || { [ -x "$HOME/.cargo/bin/rg" ] && echo "$HOME/.cargo/bin/rg"; })\n'
  + 'T=$(command -v timeout || command -v gtimeout || true)\n'
  + 'run() { if [ -n "$T" ]; then "$T" 10 "$@"; else "$@"; fi; }\n';

// Names of the files under the current folder, one per line, ignored files left out.
export const FILE_LIST_SCRIPT = FIND_RG
  + 'if [ -n "$RG" ]; then run "$RG" --files --hidden -g "!.git" -g "!node_modules" 2>/dev/null | head -n 20001\n'
  + 'elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then run git ls-files -co --exclude-standard 2>/dev/null | head -n 20001\n'
  + "else run find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | sed 's|^\\./||' | head -n 20001\nfi\n";

// Lines containing the query, as `path<NUL>line:text`. $2: F fixed string or E regex. $3: i ignore case or s exact.
export const CONTENT_SCRIPT = FIND_RG + 'q=$1; mode=$2; icase=$3\n'
  + 'if [ -n "$RG" ]; then\n'
  + '  fl=; [ "$mode" = F ] && fl=-F; ci=-s; [ "$icase" = i ] && ci=-i\n'
  + '  run "$RG" --null --line-number --no-heading --with-filename --color never $fl $ci --hidden -g "!.git" -g "!node_modules" --max-count 5 --max-columns 300 --max-columns-preview --max-filesize 1M -e "$q" . 2>/dev/null | head -n 600\n'
  + 'else\n'
  + '  fl=-E; [ "$mode" = F ] && fl=-F; ci=; [ "$icase" = i ] && ci=-i\n'
  + '  run grep -rIn --null $fl $ci --exclude-dir=.git --exclude-dir=node_modules -m 5 -e "$q" . 2>/dev/null | head -n 600\nfi\n';

// Transcript files (agent sessions) that contain the query, NUL-separated. Pi's folder follows its env var.
export const TRANSCRIPT_SCRIPT = FIND_RG + 'q=$1; mode=$2; icase=$3; shift 3\n'
  + 'for d in "$HOME/.claude/projects" "$HOME/.codex/sessions" "${PI_CODING_AGENT_SESSION_DIR:-$HOME/.pi/agent/sessions}"; do [ -d "$d" ] && set -- "$@" "$d"; done\n'
  + '[ "$#" -eq 0 ] && exit 0\n'
  + 'if [ -n "$RG" ]; then\n'
  + '  fl=; [ "$mode" = F ] && fl=-F; ci=-s; [ "$icase" = i ] && ci=-i\n'
  + '  run "$RG" -l --null --color never $fl $ci -g "*.jsonl" --max-filesize 20M -e "$q" "$@" 2>/dev/null | head -c 2000000\n'
  + 'else\n'
  + '  fl=-E; [ "$mode" = F ] && fl=-F; ci=; [ "$icase" = i ] && ci=-i\n'
  + '  run grep -rlI --null $fl $ci --include="*.jsonl" -e "$q" "$@" 2>/dev/null | head -c 2000000\nfi\n';

export const contentArgs = (query, { cs = false, regex = false } = {}) =>
  ["-c", CONTENT_SCRIPT, "search", query, regex ? "E" : "F", ignoreCase(query, cs) ? "i" : "s"];
export const transcriptArgs = (query, { cs = false, regex = false } = {}) =>
  ["-c", TRANSCRIPT_SCRIPT, "search", query, regex ? "E" : "F", ignoreCase(query, cs) ? "i" : "s"];

export const parseFileList = (out) => out.split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, ""));
export const parseTranscripts = (out) => new Set(out.split("\0").filter(Boolean));

// `path<NUL>line:text` (ripgrep and grep with --null), or `path:line:text` when there is no NUL.
export function parseHits(out, cap = 500) {
  const hits = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    let path, rest;
    const z = line.indexOf("\0");
    if (z >= 0) { path = line.slice(0, z); rest = line.slice(z + 1); }
    else { const m = /^(.+?):(\d+):(.*)$/.exec(line); if (!m) continue; path = m[1]; rest = `${m[2]}:${m[3]}`; }
    const m = /^(\d+):(.*)$/.exec(rest);
    if (!m) continue;
    hits.push({ path: path.replace(/^\.\//, ""), line: +m[1], text: m[2] });
    if (hits.length >= cap) break;
  }
  return hits;
}

// ---------------------------------------------------------------- the find bar

// State and UI of one find bar: input, options, the matches and the current one. The mod computes the
// matches (`setMatches`) and draws the marks (`marks()`: row -> ranges for splitSpans); `onChange` runs when
// the query, a mode or an option changes, `onJump(match)` when the current match moves.
// Created in the mod's init: an input state can't be made while rendering.
export class Finder {
  constructor(id, { placeholder = "Find", modes = null, onChange = null, onJump = null } = {}) {
    Object.assign(this, { id, modes, onChange, onJump, mode: modes?.[0] ?? null, open: false, query: "", cs: false, regex: false, matches: [], cur: 0, error: null, typing: false, _marks: new Map() });
    this.input = InputState.new({ placeholder });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.onChange?.(cx); });
    this.input.on("submit", (_e, cx) => this.step(1, cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
  }

  // The input is not drawn until the next frame, so focus it a moment later.
  show(cx) { this.open = true; cx.notify(); cx.timer.after(40, () => this.input.focus()); }

  hide(cx) {
    this.open = false; this.query = ""; this.input.set_value(""); this.setMatches([], null);
    this.onChange?.(cx); cx.notify();
  }

  setQuery(query, cx) { this.query = query; this.input.set_value(query); this.onChange?.(cx); }

  // Sets the mode, options and query in one go: { query, mode, cs, regex }. Used by `my-tabs.search:<json>`.
  apply(opts, cx) {
    if (this.modes?.includes(opts.mode)) this.mode = opts.mode;
    if ("cs" in opts) this.cs = Boolean(opts.cs);
    if ("regex" in opts) this.regex = Boolean(opts.regex);
    if (typeof opts.query === "string") { this.query = opts.query; this.input.set_value(opts.query); }
    this.onChange?.(cx);
  }

  setMatches(matches, error = null, keep = false) {
    this.matches = matches; this.error = error; this.cur = keep ? Math.min(this.cur, Math.max(0, matches.length - 1)) : 0;
    this.remark();
  }

  remark() {
    this._marks = new Map();
    this.matches.forEach((m, i) => {
      const list = this._marks.get(m.row) ?? [];
      list.push({ start: m.start, end: m.end, cur: i === this.cur });
      this._marks.set(m.row, list);
    });
  }

  marks() { return this._marks; }

  step(dir, cx) {
    if (!this.matches.length) return;
    this.cur = (this.cur + dir + this.matches.length) % this.matches.length;
    this.remark(); this.onJump?.(this.matches[this.cur], cx); cx.notify();
  }

  // Escape closes; shift-enter and F3 step. Returns true when the key was used.
  keyDown(e, cx) {
    if (!this.open) return false;
    if (e.key === "escape") { this.hide(cx); return true; }
    const step = { "shift-enter": -1, f3: 1, "shift-f3": -1 }[e.keystroke];
    if (step) { this.step(step, cx); return true; }
    return false;
  }

  chip(id, label, on, t, action) {
    return div().id(`${this.id}-${id}`).h(22).px(7).flex().flex_none().items_center().rounded(5).cursor_pointer().text_size(11)
      .border_1().border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(action).child(label);
  }

  // nav: previous/next buttons; options: Aa and .* chips; count: the "3/12" text.
  bar(t, { nav = true, options = true, count = true, trailing = null } = {}) {
    const changed = (fn) => (_e, cx) => { fn(); this.onChange?.(cx); cx.notify(); };
    const label = this.error ?? (this.query && nav ? (this.matches.length ? `${this.cur + 1}/${this.matches.length}` : "No results") : "");
    const chips = [
      ...(this.modes ?? []).map((m) => this.chip(`mode-${m}`, m, this.mode === m, t, changed(() => { this.mode = m; }))),
      ...(options ? [this.chip("case", "Aa", this.cs, t, changed(() => { this.cs = !this.cs; })), this.chip("regex", ".*", this.regex, t, changed(() => { this.regex = !this.regex; }))] : []),
      ...(nav ? [this.chip("prev", "▲", false, t, (_e, cx) => this.step(-1, cx)), this.chip("next", "▼", false, t, (_e, cx) => this.step(1, cx))] : []),
    ];
    return v_flex().flex_none().px(10).py(6).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().id(`${this.id}-input`).flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(7).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .when(count && Boolean(label), (el) => el.child(div().flex_none().text_size(11).text_color(this.error || label === "No results" ? t.ansi1 : t.dim).child(label)))
        .child(div().id(`${this.id}-close`).size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.hide(cx)).child("✕")))
      .when(chips.length > 0, (el) => el.child(h_flex().gap(4).items_center().children(chips).when(Boolean(trailing), (r) => r.child(div().flex_1()).child(trailing))));
  }
}
