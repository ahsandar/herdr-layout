// A Markdown preview pane. Open it beside a terminal:
//   herdr-app do pane.split --direction right --mod md-preview --props '{"file":"/abs/README.md"}'
// props: { file: absolute path, on?: machine name (null: this computer) }.
// The preview follows saves (folder watch here, a gentle poll on other machines),
// toggles to the source, and follows relative .md links inside the pane.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, Editor, EditorState } from "gpui-base";
import { readTextFile, watchFolder, theme, settings, exec, window, props } from "herdr";

const MAX = 300000;
const dirname = (p) => p.replace(/[\\/][^\\/]*$/, "") || "/";
const basename = (p) => p.split(/[\\/]/).pop();

// Resolves a link inside the document against the shown file's folder.
function resolve(file, href) {
  const target = decodeURI(href.split("#")[0]);
  if (!target) return null;
  const parts = (target.startsWith("/") ? target : `${dirname(file)}/${target}`).split("/"), out = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return "/" + out.join("/");
}

export default class MarkdownPreview extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.on = p.on ?? null;
    this.history = [];
    this.mode = "preview";
    this.open(p.file ?? p.props?.file ?? null, cx);
    // Other machines can't be watched; poll them gently.
    if (this.on) cx.timer.every(3000, (cx) => this.load(cx));
  }

  open(file, cx) {
    this.file = file; this.text = null; this.error = null; this.source?.release(); this.source = null;
    this.load(cx);
    this.watch(cx);
  }

  watch(cx) {
    if (this.on || !this.file) return;
    const dir = dirname(this.file), file = this.file;
    if (this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir) {
          const changed = await watchFolder(dir);
          if (this.watched === dir && this.file === file && changed.some((p) => p === file || basename(p) === basename(file))) this.load(cx);
        }
      } catch { if (this.watched === dir) this.watched = null; }
    });
  }

  load(cx) {
    const file = this.file;
    if (!file) { this.error = "No file given (props.file)"; cx.notify(); return; }
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(file, { on: this.on });
        if (this.file !== file) return;
        if (text === null) { this.error = "This file is no longer available"; this.text = null; }
        else if (text !== this.text) {
          this.text = text.length > MAX ? text.slice(0, MAX) + "\n\n… (file truncated)" : text;
          this.error = null; this.version = (this.version ?? 0) + 1;
          this.source?.release(); this.source = null;
          this.ensureSource();
        }
      } catch (e) { if (this.file === file) this.error = `Cannot read this file: ${e}`; }
      cx.notify();
    });
  }

  follow(href, cx) {
    if (/^(https?|mailto):/i.test(href)) {
      const w = window()?.platform;
      exec(w === "windows" ? "explorer" : w === "macos" ? "open" : "xdg-open", [href]).catch(() => null);
      return;
    }
    const target = resolve(this.file, href);
    if (!target) return;
    if (/\.(md|markdown|mdx)$/i.test(target)) { this.history.push(this.file); this.open(target, cx); }
  }

  // EditorState can't be created during render: build it when Source is picked
  // or when new text arrives while Source is showing.
  ensureSource() {
    if (this.source || this.text === null || this.mode !== "source") return;
    const t = theme();
    this.source = EditorState.new({ language: "markdown", readonly: true, value: this.text,
      font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }

  sourceView(t) {
    return this.source ? Editor.new(this.source).flex_1().min_h(0) : div().p(16).text_color(t.dim).child("Loading…");
  }

  button(id, label, on, t, action) {
    return div().id(id).h(24).px(9).flex().flex_none().items_center().rounded(6).cursor_pointer().text_size(11.5)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(action).child(label);
  }

  render() {
    const t = theme(), preview = this.mode === "preview";
    return v_flex().id("md-preview").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(38).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
        .when(this.history.length > 0, (el) => el.child(this.button("md-back", "←", false, t, (_e, cx) => this.open(this.history.pop(), cx))))
        .child(div().font_semibold().flex_none().child(this.file ? basename(this.file) : "Markdown"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.file ? dirname(this.file) : ""))
        .child(this.button("md-mode-preview", "Preview", preview, t, (_e, cx) => { this.mode = "preview"; cx.notify(); }))
        .child(this.button("md-mode-source", "Source", !preview, t, (_e, cx) => { this.mode = "source"; this.ensureSource(); cx.notify(); })))
      .when(this.text === null, (el) => el.child(div().p(16).text_color(this.error ? t.ansi1 : t.dim).child(this.error ?? "Loading…")))
      .when(this.text !== null && !preview, (el) => el.child(this.sourceView(t)))
      .when(this.text !== null && preview, (el) => el.child(
        div().id("md-scroll").flex_1().min_h(0).overflow_y_scrollbar()
          .child(h_flex().w_full().justify_center().px(24).py(18)
            .child(div().w_full().max_w(880).text_size(14)
              .child(TextView.markdown(`md-${this.version}`, this.text).selectable()
                .on_link_click((url, cx) => this.follow(url, cx)))))));
  }
}
