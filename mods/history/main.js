import { View, div, svg, image, list } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, appHome, home, theme, settings, run, notify, layout } from "herdr";

// True when `child` is the open panel: timers keep running while a panel is hidden, so they check this first.
const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).reduce((hit, c) => hit ?? find(c, id), null));
function visible(child) {
  const root = layout(), panel = find(root, "panel");
  return Boolean(panel && !panel.hidden && find(root, "panel-body")?.active === child);
}

// One entry per agent whose transcripts history.py can read. `resume` builds
// the command that reopens a session in its own folder.
const AGENTS = {
  claude: { name: "Claude", icon: "icons/claude.svg", tint: false, resume: (s) => ["claude", "--resume", s.id] },
  codex: { name: "Codex", icon: "icons/codex.svg", tint: false, resume: (s) => ["codex", "resume", s.id] },
  pi: { name: "Pi", icon: "icons/pi.svg", tint: true, resume: (s) => ["pi", "--session", s.file] },
};
const SCRIPT = () => `${appHome()}/mods/history/history.py`;
const TOOL_LINES = 6;
const LIMIT = 100; // most recent sessions shown in the list

// The folder the panel follows: the focused pane's, else the space's (as Changes does).
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, remote: Boolean(space?.machine) };
}

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function clock(ms) {
  if (!ms) return "";
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const inside = (path, root) => Boolean(path && root && (path === root || path.startsWith(root.endsWith("/") ? root : root + "/")));
const short = (path, home) => (path && home && path.startsWith(home) ? "~" + path.slice(home.length) : path ?? "");

export default class History extends View {
  init(_props, cx) {
    this.home = home(); this.sessions = []; this.agent = "all"; this.scope = "here"; this.query = "";
    this.open = null; this.transcript = null; this.typing = false;
    // Turn rail state: `start` is the first message shown (a jump to a prompt
    // starts the transcript there), `top` the message at the top of the view.
    this.start = 0; this.top = 0; this.drawnTop = Infinity;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search sessions" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    // Transcripts grow while agents work; the index is cached, so this is cheap.
    cx.timer.every(20000, (cx) => { if (visible("history")) this.refresh(cx); });
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [SCRIPT(), "list"]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
        this.sessions = JSON.parse(r.stdout); this.error = null;
      } catch (e) { this.error = `Cannot read history: ${e}`; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // "This folder" means the repo the focused folder belongs to, else the folder itself.
  syncRoot(cx) {
    const { cwd } = location();
    if (cwd === this.cwd) return;
    this.cwd = cwd; this.root = cwd;
    if (!cwd) return;
    cx.spawn(async (cx) => {
      const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => null);
      if (this.cwd === cwd && r?.code === 0) { this.root = r.stdout.trim(); cx.notify(); }
    });
  }

  show(session, cx) {
    this.open = session; this.transcript = null; this.loadError = null; this.start = 0; this.top = 0;
    const ref = session.file;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [SCRIPT(), "show", session.agent, ref]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
        if (this.open === session) this.transcript = JSON.parse(r.stdout);
      } catch (e) { if (this.open === session) this.loadError = String(e); }
      cx.notify();
    });
    cx.notify();
  }

  resume(session) {
    const argv = AGENTS[session.agent]?.resume?.(session);
    if (!argv) return;
    if (session.cwd && location().remote) notify({ title: "History", body: "Resuming on this computer", level: "info", timeout: 3000 });
    run("tab.new", { argv, ...(session.cwd ? { folder: session.cwd } : {}) });
  }

  // Resume straight from the list: a quiet play icon that becomes a button on row hover.
  quickResume(s, hot, t) {
    return h_flex().id(`resume-${s.agent}-${s.id}`).h(24).flex_none().gap(4).items_center().justify_center().rounded(6).cursor_pointer()
      .when(hot, (el) => el.px(9).bg(t.solid).text_color(t.solid_foreground).text_size(11.5))
      .when(!hot, (el) => el.w(24).text_color(t.dim))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.resume(s); })
      .child(svg("mods/history/resume.svg").size(hot ? 10 : 11))
      .when(hot, (el) => el.child("Resume"));
  }

  visible() {
    const q = this.query.trim().toLowerCase();
    return this.sessions.filter((s) =>
      (this.agent === "all" || s.agent === this.agent) &&
      (this.scope === "all" || inside(s.cwd, this.root)) &&
      (!q || s.title.toLowerCase().includes(q) || (s.cwd ?? "").toLowerCase().includes(q)));
  }

  icon(agent, size, t) {
    const a = AGENTS[agent];
    if (!a) return div().size(size);
    return a.tint ? svg(a.icon).size(size).flex_none().text_color(t.foreground) : image(a.icon).size(size).flex_none();
  }

  chip(id, label, on, t, action, icon) {
    return h_flex().id(id).h(24).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer().text_size(11.5)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).border_1().border_color(on ? t.border : t.background)
      .hover((s) => s.bg(t.hover)).on_click(action)
      .when(Boolean(icon), (el) => el.child(icon)).child(label);
  }

  header(t, children) {
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border).children(children);
  }

  renderList(t) {
    const list = this.visible();
    const here = this.scope === "here", counts = {};
    for (const s of this.sessions) if (this.scope === "all" || inside(s.cwd, this.root)) counts[s.agent] = (counts[s.agent] ?? 0) + 1;
    const present = Object.keys(AGENTS).filter((a) => counts[a]);
    const empty = this.error || (this.loading && !this.sessions.length ? "Loading sessions…"
      : here && !this.root ? "No folder" : this.query ? "No matching sessions" : here ? "No sessions in this folder" : "No sessions");
    return v_flex().size_full().min_h(0)
      .child(this.header(t, [
        div().font_semibold().child("History"),
        div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${list.length}`),
        div().flex_1(),
        this.chip("scope-here", "This folder", here, t, (_e, cx) => { this.scope = "here"; cx.notify(); }),
        this.chip("scope-all", "All", !here, t, (_e, cx) => { this.scope = "all"; cx.notify(); }),
        div().id("history-refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx))
          .child(svg("mods/history/history.svg").size(14).when(this.loading, (el) => el.spin(900))),
      ]))
      .child(v_flex().flex_none().px(10).pt(10).pb(8).gap(8).border_b(1).border_color(t.border)
        .child(div().id("history-search").h(30).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(h_flex().id("history-agents").gap(4).overflow_x_scrollbar()
          .child(this.chip("agent-all", "All", this.agent === "all", t, (_e, cx) => { this.agent = "all"; cx.notify(); }))
          .children(present.map((a) => this.chip(`agent-${a}`, `${AGENTS[a].name} ${counts[a]}`, this.agent === a, t,
            (_e, cx) => { this.agent = this.agent === a ? "all" : a; cx.notify(); }, this.icon(a, 13, t))))))
      .child(v_flex().id("history-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .when(!list.length, (el) => el.child(div().p(8).text_color(t.dim).child(empty)))
        .children(list.slice(0, LIMIT).map((s) =>
          h_flex().id(`session-${s.agent}-${s.id}`).flex_none().px(8).py(7).gap(10).items_center().rounded(8).cursor_pointer()
            .hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.show(s, cx))
            .on_hover((hovered, cx) => {
              const key = `${s.agent}-${s.id}`;
              if (hovered) this.hot = key; else if (this.hot === key) this.hot = null;
              cx.notify();
            })
            .child(this.icon(s.agent, 16, t))
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(div().text_size(12.5).truncate().child(s.title || "(untitled)"))
              .child(h_flex().gap(6).text_size(11).text_color(t.dim)
                .child(div().flex_none().child(ago(s.updated)))
                .child(div().flex_none().child(`· ${s.turns} ${s.turns === 1 ? "prompt" : "prompts"}`))
                .when(!here, (el) => el.child(div().min_w(0).truncate().child(`· ${short(s.cwd, this.home)}`)))))
            .when(Boolean(AGENTS[s.agent]?.resume), (el) => el.child(this.quickResume(s, this.hot === `${s.agent}-${s.id}`, t))))))
      .when(list.length > LIMIT, (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(`Showing the ${LIMIT} most recent of ${list.length}; search to narrow`)));
  }

  message(m, i, t) {
    const agent = AGENTS[this.open.agent]?.name ?? "Agent";
    if (m.role === "tool") {
      const lines = m.text.split("\n"), shown = lines.slice(0, TOOL_LINES);
      return v_flex().flex_none().mx(12).px(10).py(5).rounded(6).bg(t.surface).border_1().border_color(t.border)
        .font_family(settings().font_family ?? "JetBrains Mono").text_size(10.5).text_color(t.dim)
        .children(shown.map((line) => div().truncate().child(`▸ ${line}`)))
        .when(lines.length > TOOL_LINES, (el) => el.child(div().child(`… ${lines.length - TOOL_LINES} more tool calls`)));
    }
    const user = m.role === "user";
    return v_flex().flex_none().mx(12).gap(4).when(user, (el) => el.px(10).py(8).rounded(8).bg(t.raised))
      .child(h_flex().gap(6).text_size(10.5).text_color(t.dim)
        .child(div().font_semibold().text_color(user ? t.accent : t.muted).child(user ? "You" : agent))
        .child(div().child(clock(m.time))))
      .child(div().text_size(12.5).text_color(t.foreground).child(TextView.markdown(`msg-${i}`, m.text).selectable()));
  }

  renderSession(t) {
    const s = this.open, a = AGENTS[s.agent], can = Boolean(a?.resume);
    const tr = this.transcript;
    return v_flex().size_full().min_h(0)
      .child(this.header(t, [
        div().id("history-back").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_size(16).text_color(t.muted)
          .hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.open = null; this.transcript = null; cx.notify(); }).child("‹"),
        this.icon(s.agent, 16, t),
        div().flex_1().min_w(0).font_semibold().truncate().child(s.title || "(untitled)"),
      ]))
      .child(h_flex().flex_none().px(14).py(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().child(short(s.cwd, this.home) || "(unknown folder)"))
          .child(div().truncate().child(`${a?.name ?? s.agent} · ${clock(s.created)} → ${ago(s.updated)}`)))
        .child(div().id("history-resume").h(28).px(12).flex_none().flex().items_center().rounded(7).text_size(12)
          .bg(can ? t.solid : t.raised).text_color(can ? t.solid_foreground : t.dim).when(can, (el) => el.cursor_pointer())
          .on_click(() => this.resume(s)).child(can ? "Resume" : "View only")))
      .when(!tr, (el) => el.child(div().px(14).py(12).text_color(this.loadError ? t.ansi1 : t.dim).child(this.loadError ?? "Loading transcript…")))
      .when(Boolean(tr && tr.total > tr.messages.length), (el) => el.child(div().flex_none().px(14).pt(8).text_size(11).text_color(t.dim)
        .child(`Showing the last ${tr.messages.length} of ${tr.total} entries`)))
      .when(Boolean(tr && !tr.messages.length), (el) => el.child(div().px(14).py(12).text_color(t.dim).child("No messages")))
      .when(Boolean(tr?.messages.length), (el) => el.child(this.renderTranscript(tr.messages, t)));
  }

  // The transcript, with a rail on the right: one dot per prompt you sent.
  // Hover a dot for the prompt; click it to read from there. The lazy list
  // can't be scrolled from code, so a jump starts the list at that prompt
  // (a fresh list id) and a bar above it brings back what came before.
  renderTranscript(messages, t) {
    const turns = [];
    messages.forEach((m, i) => { if (m.role === "user") turns.push(i); });
    const start = Math.min(this.start, messages.length - 1), shown = messages.length - start;
    // Rows are drawn during layout, after render; the first one drawn last
    // time is the message at the top of the view.
    if (this.drawnTop !== Infinity) this.top = this.drawnTop;
    this.drawnTop = Infinity;
    let current = 0;
    turns.forEach((i, k) => { if (i <= this.top) current = k; });
    const id = `history-transcript-${start}`;
    return h_flex().flex_1().min_h(0)
      .child(v_flex().flex_1().min_w(0).h_full()
        .when(start > 0, (el) => el.child(h_flex().id("history-earlier").flex_none().mx(12).mt(8).h(26).px(10).gap(6).items_center().justify_center()
          .rounded(6).border_1().border_color(t.border).cursor_pointer().text_size(11).text_color(t.muted)
          .hover((st) => st.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.start = 0; this.top = 0; cx.notify(); })
          .child(`↑ Show ${start} earlier ${start === 1 ? "entry" : "entries"}`)))
        .child(div().id(`${id}-box`).relative().flex_1().min_h(0)
          // The wheel moves the list itself; render again once it has, so the lit dot follows.
          .on_scroll_wheel((_e, cx) => { cx.notify(); cx.timer.after(50, (cx) => cx.notify()); })
          .child(list(id, shown, (i) => `m${start + i}`, (i) => {
            const at = start + i;
            if (at < this.drawnTop) this.drawnTop = at;
            return div().w_full().pt(i === 0 ? 12 : 0).pb(i === shown - 1 ? 12 : 10).child(this.message(messages[at], at, t));
          }).size_full())
          .child(Scrollbar.vertical(id).absolute().inset_0())))
      .when(turns.length > 1, (el) => el.child(this.turnRail(turns, messages, current, t)));
  }

  turnRail(turns, messages, current, t) {
    return v_flex().id("history-turns").w(18).flex_none().h_full().py(10).items_center().justify_center().border_l(1).border_color(t.border)
      .children(turns.map((i, k) => {
        const on = k === current, text = messages[i].text.replace(/\s+/g, " ").trim();
        return div().id(`turn-${k}`).w_full().flex_1().min_h(3).max_h(18).flex().items_center().justify_center().cursor_pointer()
          .rounded(4).hover((s) => s.bg(t.hover))
          .tooltip(`${k + 1}/${turns.length} · ${text.length > 120 ? text.slice(0, 120) + "…" : text}`)
          .on_click((_e, cx) => { this.start = k === 0 ? 0 : i; this.top = i; cx.notify(); })
          .child(div().flex_none().rounded(4).when(on, (d) => d.size(8).bg(t.accent)).when(!on, (d) => d.size(5).bg(t.dim)));
      }));
  }

  render(cx) {
    const shown = visible("history");
    if (shown && !this.wasShown) this.refresh(cx);
    this.wasShown = shown;
    this.syncRoot(cx);
    const t = theme();
    return v_flex().id("history").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.typing) { this.typing = false; this.handle.focus(); }
        else if (this.open) { this.open = null; this.transcript = null; }
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(this.open ? this.renderSession(t) : this.renderList(t));
  }
}
