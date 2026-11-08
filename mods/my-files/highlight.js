// Syntax highlighting + diff rows shared by my-changes and my-files (keep the two copies identical).
// A small regex tokenizer, not a parser: keywords, strings, comments, numbers, calls and Capitalised types.
// shortcut: single-line strings, no regex literals/heredocs/nested comments; diff hunks start with unknown
// block-comment state. Upgrade to the native Editor (tree-sitter) if exact colouring matters.
import { div } from "gpui-kit";
import { h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { splitSpans } from "./search.js";

export const READ = ["--literal-pathspecs", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

const w = (s) => s.split(" ");
const CB = [["/*", "*/"]];
const C = { lines: ["//"], blocks: CB, str: `"'\`` };
const HASH = { lines: ["#"], str: `"'\`` };
const DASH = { lines: ["--"], str: `"'` };

const c_kw = "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while NULL true false bool";
const cpp_kw = c_kw + " alignas catch class concept constexpr const_cast co_await co_return co_yield delete dynamic_cast explicit export friend mutable namespace new noexcept nullptr operator override private protected public reinterpret_cast requires static_cast template this throw try typename using virtual final";
const vb_kw = "addhandler and andalso as boolean byref byte byval call case catch class const continue date decimal declare default delegate dim do double each else elseif end enum erase error event exit false finally for friend function get global gosub goto handles if implements imports in inherits integer interface is let lib like long loop me mod module mustinherit mustoverride mybase myclass namespace new next not nothing notinheritable of on option optional or orelse overloads overridable overrides paramarray preserve private property protected public raiseevent readonly redim rem resume return select set shared short single static step stop string structure sub synclock then throw to true try typeof until using variant wend when while with withevents writeonly xor";
const js_kw = "async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined";
const lisp_kw = "defun defmacro defvar defparameter defclass defmethod defgeneric defstruct let let* letrec lambda if cond case when unless progn setq setf loop do dolist dotimes and or not nil t quote function funcall apply define begin set! else def defn defmulti defprotocol defrecord deftype ns fn if-let when-let recur try catch finally throw require use import true false";
const sql_kw = "select from where and or not null insert into values update set delete create alter drop table index view join inner outer left right full on group by order having limit offset union all distinct as in is like between exists case when then else end primary key foreign references default constraint begin declare procedure function trigger return if while for loop cursor open fetch close commit rollback exec execute go use top with over partition varchar int integer number date";

// Profiles. ci: case-insensitive keywords. blocks: [open, close, class?]. id: identifier regex.
const P = {
  c: { ...C, pp: 1, kw: c_kw },
  cpp: { ...C, pp: 1, kw: cpp_kw },
  objc: { ...C, pp: 1, kw: c_kw + " @interface @implementation @end @property @synthesize @protocol @class @selector @try @catch @finally @throw @autoreleasepool self super nil YES NO id BOOL" },
  java: { ...C, kw: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try var void volatile while record sealed permits yield true false null" },
  csharp: { ...C, pp: 1, kw: "abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var async await record init get set yield partial where" },
  js: { ...C, kw: js_kw },
  ts: { ...C, kw: js_kw + " abstract as declare enum implements interface keyof namespace private protected public readonly type satisfies unknown never any string number boolean" },
  python: { lines: ["#"], blocks: [['"""', '"""', "s"], ["'''", "'''", "s"]], str: `"'`, kw: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None match case self" },
  r: { ...HASH, kw: "if else repeat while function for in next break TRUE FALSE NULL NA NA_integer_ NA_real_ NA_character_ Inf NaN library require" },
  sql: { lines: ["--"], blocks: CB, str: `"'`, ci: 1, kw: sql_kw },
  vb: { lines: ["'", "rem "], str: `"`, ci: 1, kw: vb_kw },
  xojo: { lines: ["'", "//", "rem "], str: `"`, ci: 1, kw: vb_kw },
  go: { ...C, kw: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota" },
  rust: { ...C, str: `"`, kw: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while" },
  php: { lines: ["//"], blocks: CB, str: `"'\``, kw: "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null" },
  fortran: { lines: ["!"], str: `"'`, ci: 1, kw: "program end subroutine function module use implicit none integer real double precision complex character logical dimension parameter allocatable allocate deallocate if then else elseif endif do while enddo call return stop contains intent in out inout select case where forall type interface public private save data common equivalence write read print format open close" },
  perl: { ...HASH, kw: "my our local sub package use require if elsif else unless while until for foreach do last next redo return and or not xor eq ne lt gt le ge cmp print say die warn defined undef ref bless qw" },
  matlab: { lines: ["%"], blocks: [["%{", "%}"]], str: `"`, kw: "break case catch classdef continue else elseif end for function global if otherwise parfor persistent return switch try while properties methods events true false" },
  asm: { lines: [";", "#", "//"], blocks: CB, str: `"'`, ci: 1, kw: "mov movl movq add sub mul div push pop call ret jmp je jne jz jnz jg jl jge jle cmp test lea inc dec and or xor not shl shr int nop section segment global globl extern db dw dd dq resb resw equ times byte word dword qword ptr offset syscall leave" },
  swift: { ...C, kw: "associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough false fileprivate for func guard if import in init inout internal is let nil open operator private protocol public repeat rethrows return self Self static struct subscript super switch throw throws true try typealias var where while" },
  pascal: { lines: ["//"], blocks: [["(*", "*)"], ["{", "}"]], str: `'`, ci: 1, kw: "and array as begin case class const constructor destructor div do downto else end except false file finally for function goto if implementation in inherited interface is label mod nil not object of on or packed private procedure program property protected public raise record repeat set shl shr then to true try type unit until uses var while with xor string integer boolean" },
  dart: { ...C, kw: "abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for Function get hide if implements import in interface is late library mixin new null on operator part required rethrow return set show static super switch sync this throw true try typedef var void while with yield" },
  cobol: { lines: ["*>"], bol: "*", col7: 1, str: `"'`, ci: 1, id: /^[A-Za-z_][\w-]*/, kw: "accept add call close compute continue delete display divide else end-if end-perform evaluate exit file goto identification division section if initialize move multiply open perform program-id read return rewrite search set start stop string subtract unstring when write working-storage data procedure environment pic picture value using giving from to by until varying thru through zero zeros space spaces" },
  abap: { lines: ['"'], bol: "*", str: `'\`|`, ci: 1, id: /^[A-Za-z_][\w-]*/, kw: "report data types constants parameters select-options start-of-selection end-of-selection form endform perform method endmethod class endclass implementation definition public section private protected if elseif else endif case when endcase do enddo while endwhile loop endloop at into from where select endselect insert update modify delete read table write call function exporting importing changing tables exceptions raise try catch endtry type ref to like value" },
  sas: { lines: [], blocks: CB, bol: "*", str: `"'`, ci: 1, kw: "data set run proc quit if then else do end output input infile file put merge by retain keep drop where options libname filename macro mend let sort print means freq sql select from create table" },
  ruby: { ...HASH, kw: "alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require include extend attr_accessor attr_reader attr_writer puts" },
  prolog: { lines: ["%"], blocks: CB, str: `"'`, kw: "is mod rem dynamic discontiguous module use_module true fail not halt" },
  lua: { lines: ["--"], blocks: [["--[[", "]]"]], str: `"'`, kw: "and break do else elseif end false for function goto if in local nil not or repeat return then true until while" },
  kotlin: { ...C, kw: "abstract annotation as break by catch class companion const constructor continue crossinline data do else enum expect external false final finally for fun get if import in infix init inline inner interface internal is lateinit noinline null object open operator out override package private protected public reified return sealed set super suspend this throw true try typealias val var vararg when where while" },
  ocaml: { lines: [], blocks: [["(*", "*)"]], str: `"`, kw: "and as assert begin class constraint do done downto else end exception external false for fun function functor if in include inherit initializer lazy let match method module mutable new object of open or private rec sig struct then to true try type val virtual when while with" },
  sml: { lines: [], blocks: [["(*", "*)"]], str: `"`, kw: "abstype and andalso as case datatype do else end eqtype exception fn fun functor handle if in include infix infixr let local nonfix of op open orelse raise rec sharing sig signature struct structure then type val where while with withtype" },
  d: { lines: ["//"], blocks: [["/*", "*/"], ["/+", "+/"]], str: `"'\``, kw: "abstract alias align asm assert auto bool break byte case cast catch char class const continue dchar debug default delegate do double else enum export extern false final finally float for foreach function goto if immutable import in inout int interface invariant is lazy long module new nothrow null out override package pragma private protected public pure real ref return scope shared short static struct super switch synchronized template this throw true try typeof ubyte uint ulong union unittest ushort version void while with" },
  lisp: { lines: [";"], blocks: [["#|", "|#"]], str: `"`, ci: 1, id: /^[A-Za-z_*!?<>=:][\w*+!?<>=:.\/-]*/, nofn: 1, kw: lisp_kw },
  scala: { ...C, kw: "abstract case catch class def do else extends false final finally for forSome if implicit import lazy match new null object override package private protected return sealed super this throw trait try true type val var while with yield given using enum then export" },
  haskell: { lines: ["--"], blocks: [["{-", "-}"]], str: `"`, kw: "case class data default deriving do else forall foreign if import in infix infixl infixr instance let module newtype of then type where True False" },
  gml: { ...C, kw: "var globalvar if else for while do until repeat switch case default break continue exit return function with enum true false undefined self other global noone all" },
  foxpro: { lines: ["&&"], bol: "*", str: `"'`, ci: 1, kw: "if else endif do while enddo for endfor next case endcase otherwise function procedure endproc return local private public parameters select use append replace delete scan endscan set store clear" },
  xml: { lines: [], blocks: [["<!--", "-->"]], str: `"`, tag: 1, kw: "" },
  solidity: { ...C, kw: "abstract address anonymous assembly bool break bytes calldata catch constant constructor continue contract delete do else emit enum error event external fallback false for function if immutable import indexed interface internal is library mapping memory modifier new override payable pragma private public pure receive return returns revert storage string struct this throw true try uint int unchecked using view virtual while" },
  ada: { ...DASH, str: `"`, ci: 1, kw: "abort abs abstract accept access aliased all and array at begin body case constant declare delay delta digits do else elsif end entry exception exit for function generic goto if in interface is limited loop mod new not null of or others out overriding package pragma private procedure protected raise range record rem renames requires return reverse select separate some subtype synchronized tagged task terminate then type until use when while with xor" },
  julia: { lines: ["#"], blocks: [["#=", "=#"], ['"""', '"""', "s"]], str: `"`, kw: "abstract type baremodule begin break catch const continue do else elseif end export false finally for function global if import in isa let local macro module mutable struct nothing quote return true try using where while" },
  elixir: { ...HASH, str: `"'`, kw: "alias and case catch cond def defmacro defmodule defp defprotocol defimpl defstruct defdelegate do else end false fn for if import in nil not or quote raise receive require rescue true try unless unquote use when with" },
  shell: { ...HASH, kw: "if then else elif fi case esac for while until do done in function select time return exit export local readonly declare unset shift set source alias echo cd test true false" },
  yaml: { ...HASH, str: `"'`, kw: "true false null yes no" },
  json: { lines: [], str: `"`, kw: "true false null" },
  css: { lines: [], blocks: CB, str: `"'`, kw: "" },
};
for (const p of Object.values(P)) { p.set = new Set(w(p.kw ?? "").map((k) => (p.ci ? k.toLowerCase() : k))); p.id ??= /^[@$]?[A-Za-z_][\w$]*/; }

// TIOBE top 50 (Nov 2026) plus the config/markup formats people actually diff.
// Skipped: Scratch, Ladder Logic and LabVIEW (graphical, no text source), ML/SQL dialects share a profile.
// `.m` is Objective-C here (MATLAB shares it), `.pl` is Perl (Prolog uses .pro).
const EXT = {
  c: "c h", cpp: "cpp cc cxx hpp hh hxx ipp", objc: "m mm", java: "java", csharp: "cs csx", js: "js jsx mjs cjs", ts: "ts tsx mts cts",
  python: "py pyw pyi", r: "r R rmd", sql: "sql pls plsql pks pkb tsql psql", vb: "vb vbs bas cls frm vba", xojo: "xojo_code xojo_script", go: "go",
  rust: "rs", php: "php phtml", fortran: "f for f77 f90 f95 f03 f08 ftn", perl: "pl pm t", matlab: "matlab", asm: "asm s S nasm",
  swift: "swift", pascal: "pas dpr lpr pp", dart: "dart", cobol: "cob cbl cobol cpy", abap: "abap", sas: "sas",
  ruby: "rb rake gemspec", prolog: "pro prolog", lua: "lua", kotlin: "kt kts", ocaml: "ml mli", sml: "sml sig fun", d: "d",
  lisp: "lisp lsp cl el scm ss rkt clj cljs cljc edn", scala: "scala sc sbt", haskell: "hs lhs", gml: "gml", foxpro: "prg",
  xml: "xml xsl xslt xsd html htm svg", solidity: "sol", ada: "adb ads ada", julia: "jl", elixir: "ex exs eex heex",
  shell: "sh bash zsh", yaml: "yml yaml toml ini", json: "json jsonc", css: "css scss less",
};
const BY_EXT = {};
for (const [lang, exts] of Object.entries(EXT)) for (const e of w(exts)) BY_EXT[e] ??= lang;

// Languages the native editor already highlights well; Files uses it for these (folding, selection, big files).
// Everything else with a profile above goes through the tokenizer. Aliases carry over from the stock Files mod.
const EDITOR = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const EDITOR_NATIVE = w("js json yaml yml toml html css md markdown py rs go c cpp java rb sh bash");
export function editorLang(path) {
  const e = ext(path);
  return EDITOR[e] ?? (EDITOR_NATIVE.includes(e) ? e : null);
}
const ext = (path) => (path.includes(".") ? path.split(".").pop() : "");
export const profileFor = (path) => (path ? P[BY_EXT[ext(path)]] ?? P[BY_EXT[ext(path).toLowerCase()]] : undefined);

const NUM = /^(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const TAG = /^<\/?[A-Za-z][\w:.-]*/;
const WORD = /[\w$]/;

// st: null or [closer, class]. Returns { spans: [[class, text]], st }. Classes: k s c n f t, "" = plain.
export function tokenize(text, p, st = null) {
  const spans = [], add = (k, s) => { if (!s) return; const l = spans[spans.length - 1]; if (l && l[0] === k) l[1] += s; else spans.push([k, s]); };
  if (!p || text.length > 1200) return { spans: [["", text]], st };
  const trimmed = text.trimStart();
  if (!st && p.bol && (text[0] === p.bol || (p.col7 && text[6] === p.bol))) return { spans: [["c", text]], st };
  // Javadoc-style continuation lines when the hunk started inside a /* block.
  if (!st && p.blocks === CB && p.lines[0] === "//" && (trimmed === "*" || trimmed.startsWith("* ") || trimmed.startsWith("*/"))) return { spans: [["c", text]], st };
  let i = 0;
  while (i < text.length) {
    if (st) {
      const j = text.indexOf(st[0], i);
      if (j < 0) { add(st[1], text.slice(i)); i = text.length; break; }
      add(st[1], text.slice(i, j + st[0].length)); i = j + st[0].length; st = null; continue;
    }
    const rest = text.slice(i);
    const blk = p.blocks?.find((b) => rest.startsWith(b[0]));
    if (blk) { st = [blk[1], blk[2] ?? "c"]; add(st[1], blk[0]); i += blk[0].length; continue; }
    const ln = p.lines.find((l) => (p.ci ? rest.slice(0, l.length).toLowerCase() === l : rest.startsWith(l)));
    if (ln) { add("c", rest); break; }
    const ch = text[i];
    if (p.str.includes(ch)) {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      add("s", text.slice(i, j + 1)); i = j + 1; continue;
    }
    if (p.tag) { const m = TAG.exec(rest); if (m) { add("k", m[0]); i += m[0].length; continue; } }
    if (p.pp && ch === "#" && !text.slice(0, i).trim()) { const m = /^#\s*\w+/.exec(rest); if (m) { add("k", m[0]); i += m[0].length; continue; } }
    if (!(i && WORD.test(text[i - 1]))) {
      const n = NUM.exec(rest);
      if (n) { add("n", n[0]); i += n[0].length; continue; }
    }
    const m = p.id.exec(rest);
    if (m && !(i && WORD.test(text[i - 1]))) {
      const word = m[0], after = rest[word.length];
      const key = p.ci ? word.toLowerCase() : word;
      add(p.set.has(key) ? "k" : p.tag && after === "=" ? "t" : !p.nofn && after === "(" ? "f" : /^[A-Z][A-Za-z0-9]*[a-z]/.test(word) ? "t" : "", word);
      i += word.length; continue;
    }
    add("", ch); i += 1;
  }
  return { spans, st };
}

// Rows for a unified diff body (from the first @@ on). Block-comment state is tracked for the old
// and new side separately: context lines advance both, '-' only old, '+' only new.
export function diffRows(lines, path) {
  const p = profileFor(path);
  let old = 0, next = 0, os = null, ns = null;
  const rows = lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; os = ns = null; return { kind: "@", text: line }; }
    const kind = line[0], text = line.slice(1).replace(/\r$/, "") || " ";
    if (kind === "-") { const r = tokenize(text, p, os); os = r.st; return { kind, number: old++, spans: r.spans }; }
    if (kind === "+") { const r = tokenize(text, p, ns); ns = r.st; return { kind, number: next++, spans: r.spans }; }
    if (kind === " ") { const r = tokenize(text, p, ns); os = ns = r.st; old++; return { kind, number: next++, spans: r.spans }; }
    return { kind: "", spans: [["", line]] };
  });
  return { rows, width: Math.max(300, ...lines.map((l) => l.length * 8 + 60)) };
}

// A whole file as context rows (the Files tokenizer view).
export function fileRows(text, path) {
  const cut = text.length > 400000, lines = (cut ? text.slice(0, 400000) : text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  // The hunk header only sets the first line number; the view starts at line 1 (row i is line i + 1).
  const d = diffRows([`@@ -1 +1 @@`, ...lines.slice(0, 5000).map((l) => " " + l)], path);
  d.rows.shift();
  if (cut || lines.length > 5000) d.rows.push({ kind: "", spans: [["", "… (file truncated)"]] });
  return d;
}

// A file with no committed version shows as all-added.
export function addedLines(text) {
  const lines = text.replace(/\n$/, "").split("\n").slice(0, 1500);
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)];
}

const COLOR = (t) => ({ k: t.ansi5, s: t.ansi2, c: t.dim, f: t.ansi4, t: t.ansi3, n: t.ansi1 });

export function row({ kind, number, text, spans }, t, colors = COLOR(t)) {
  if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
  return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
    .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
    .child(h_flex().flex_1().min_w(0).overflow_hidden().children(spans.map(([k, s, found]) => {
      const el = div().flex_none().whitespace_nowrap().child(s), coloured = colors[k] ? el.text_color(colors[k]) : el;
      // found: 1 is a search match, 2 the current one (see search.js splitSpans)
      return found ? coloured.bg(found === 2 ? t.accent + "99" : t.ansi3 + "55") : coloured;
    })));
}

// The text of each row, for searching: no gutter, no +/- prefix. Hunk headers are not searched.
export const rowTexts = (rows) => rows.map((r) => (r.spans ? r.spans.map((s) => s[1]).join("") : ""));

// The scrolling code/diff surface: virtual vertical list inside a horizontal scroller.
// handle: a VirtualListScrollHandle, so the caller can scroll to a row. marks: row index -> ranges to highlight.
export function codeView(id, { rows, width }, t, fontFamily, size = 11, { handle = null, marks = null } = {}) {
  const colors = COLOR(t);
  let list = v_virtual_list(id, rows.length, 20, (i) => String(i),
    (range) => rows.slice(range.start, range.end).map((r, k) => row(marks?.has(range.start + k) ? { ...r, spans: splitSpans(r.spans, marks.get(range.start + k)) } : r, t, colors))).size_full();
  if (handle) list = list.track_scroll(handle);
  return div().flex_1().min_h(0).relative().font_family(fontFamily ?? "JetBrains Mono").text_size(size)
    .child(div().id(`${id}-x`).size_full().overflow_x_scrollbar()
      .child(div().w_full().min_w(width).h_full().child(list)))
    .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
}
