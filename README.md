# herdr-layout

A [Herdr](https://herdr.dev) layout (`my-layout`) that turns the right-hand panel into a six-tab
workbench: **Files**, **Changes**, **Graph**, **Activity**, **Context** and **History**. Each tab has its
own button in the tab bar, and clicking the open one closes the panel again.

It is Herdr's own `main` layout with the right panel changed and one addition to the spaces sidebar (below), so the
agents list, pane cards and status bar are the ones you already know.

This repo is also a backup: every mod is in `mods/`, so a fresh install needs nothing but this repo.

## The tabs

| Tab | What it does | Comes from |
|---|---|---|
| **Files** | File tree with git status marks. Opening a file shows it with syntax highlighting for the TIOBE top 50 languages (see below). Changed files get a **File / Diff** toggle. Markdown files are rendered, with **Preview / Source** chips and **↗** to open a live preview pane beside the terminal. | `my-files` + `md-preview` |
| **Changes** | Every file that is not on a remote yet: edited, untracked, or committed but not pushed, with +/- counts. Filter chips (all, uncommitted, untracked, unpushed, recommit) show how many of each; `recommit` marks a file edited again after it was committed. A syntax-highlighted diff for the selected file, and a commit box. | `my-changes` |
| **Graph** | The repo's commit graph from [`git-graph`](https://github.com/mlange-42/git-graph), updated as commits and branches change. A **branch filter** picks one or more branches, with a **Local only** switch; the choice is remembered per folder. An `N uncommitted` badge shows working-tree changes. | `my-graph` |
| **Activity** | What the focused agent has done: prompts, steps, replies and running sub-agents. | `bettr-activity` (from [bettr](https://github.com/dissimulate/bettr), see [THIRD_PARTY.md](THIRD_PARTY.md)) |
| **Context** | How full the focused agent's context window is, split by kind, plus a prompt-cache overview. Works for Claude Code and Codex (through hooks), and for **Pi** and **opencode** with nothing installed in them (see below). | `bettr-context` (from bettr, patched) |
| **History** | Past Claude Code, Codex and Pi sessions with search, transcripts and a **Resume** button that reopens a session in a new tab. | `history` (from [herdr-main-usage](https://github.com/plutotw/herdr-main-usage), patched) |

Activity and Context only fill in once the agent hooks are installed (see [Install](#install)), except Context for
**Pi** and **opencode**: they have no hook file, so while one is focused the Context tab runs `bettr-reporter/pull.py`
every 5 seconds and reads what the agent already wrote. Pi: its newest session file for that folder
(`~/.pi/agent/sessions`), with window sizes from Pi's own model lists. opencode: its SQLite database
(`~/.local/share/opencode/opencode.db`, opened read-only) and its `~/.cache/opencode/models.json`. Nothing is added to either
agent and no package is needed beyond Python 3. Activity for Pi and opencode is not covered.

### Search

Every tab can search what it shows. Click the 🔍 in a tab's header, or bind a key (a `global` entry in
`~/.config/herdr-app/keys.json`; `ctrl-f` belongs to your shell and editors, so pick another):

```json
"ctrl-alt-f": "my-tabs.search"
```

The key opens the find bar of whichever tab is open. Enter or ▼ goes to the next match, ▲ to the previous,
Esc closes. `Aa` forces case (the default is smart case: lowercase queries ignore case) and `.*` turns on
regular expressions.

| Tab | Searches |
|---|---|
| **Files** | The tree: **Name** (fuzzy file names, instantly) or **Content** (every file, grouped, click a hit to open it at that line). An open file: find in file with highlighted matches. |
| **Changes** | **Files**: filter the changed files by path. **Diff**: find in the diff shown. |
| **Graph** | The commit lines shown (hash, refs, subject), highlighted. |
| **History** | The search box finds sessions by title and folder; the **Transcripts** chip searches inside every transcript instead. In an open transcript, find jumps message to message. |

Content search uses [ripgrep](https://github.com/BurntSushi/ripgrep) when it is installed and plain `grep`
otherwise; `.git` and ignored files are skipped (ripgrep) and binary files are never searched. It is local
folders only, capped at 500 hits (5 per file, 1 MB per file, 10 seconds), of which the first 200 are shown.

It can also be driven from a script or a key binding, with a query or a JSON object:

```sh
herdr-app do 'my-tabs.search:todo'
herdr-app do 'my-tabs.search:{"mode":"Content","query":"TODO","regex":false}'
herdr-app do 'my-tabs.search:{"file":"README.md","query":"install"}'   # Files: open the file, then find
```

### Syntax highlighting

Diffs in Changes and non-native files in Files go through a small regex tokenizer
(`mods/my-changes/highlight.js`, duplicated in `my-files`) with profiles for the TIOBE top 50 languages
that have text source (Python, C, Java, C++, C#, JavaScript, R, SQL, Visual Basic, Go, Rust, PHP, Fortran,
Perl, MATLAB, Assembly, Swift, Delphi/Pascal, Dart, VBScript, COBOL, ABAP, SAS, PL/SQL, Ada, Objective-C,
Ruby, Prolog, Lua, Kotlin, OCaml, D, Lisp, Scala, Haskell, TypeScript, GML, ML, Xojo, FoxPro, XSLT,
T-SQL, Solidity, Clojure, Julia, Elixir and more), plus shell, YAML, JSON, CSS and XML/HTML. Scratch,
Ladder Logic and LabVIEW are skipped: they have no text source. Common languages in the Files tab use
Herdr's native editor instead.

Limits: it is a tokenizer, not a parser. Strings are single-line, regex literals and heredocs are not
understood, `.m` is treated as Objective-C (MATLAB shares it) and `.pl` as Perl (Prolog uses `.pro`).

## Requirements

- Herdr **0.1.13** or later (`herdr-app` on `PATH`). `my-spaces` is a copy of 0.1.15's `spaces` and has not been tried on 0.1.13.
- `git`, and `sh` for the installer.
- [`git-graph`](https://github.com/mlange-42/git-graph) for the Graph tab: `cargo install git-graph`.
  The mod also looks in `~/.cargo/bin` and `~/.asdf/installs/rust/*/bin`, because Herdr starts programs
  with a different `PATH` than your shell.
- `python3` for History and the hooks.
- Claude Code (or Codex) for Activity, Context and History. Other agents appear in Herdr as usual.

Built and used on Linux. macOS should work but is untested.

## Install

```sh
git clone https://github.com/ahsandar/herdr-layout.git
cd herdr-layout
scripts/install.sh                 # layout + all mods, then herdr-app check on each
herdr-app do layout.switch '{"name":"my-layout"}'
```

`ctrl-shift-l` switches back to your previous layout.

Options:

- `--update`: replace what is already installed. Old copies are moved to
  `~/.config/herdr-app/.backups/herdr-layout-<time>/`, never deleted. Without it the installer refuses to
  overwrite anything.
- `--own-only`: install only Files, Changes, Graph, the tab bar and the spaces list; skip Activity, Context, History and
  the Markdown pane.
- `--hooks`: also install the agent hooks that feed Activity and Context. **Off by default**: it edits
  `~/.claude/settings.json` (and `~/.codex/hooks.json`, if Codex is installed) and runs `python3` on agent
  events. Equivalent: `python3 -I ~/.config/herdr-app/mods/bettr-reporter/setup.py install`. Hooks load
  when an agent session starts or resumes.
- `HERDR_APP_HOME=/some/folder` installs somewhere other than `~/.config/herdr-app`.

### Uninstall

Switch to another layout, then delete `layouts/my-layout.json` and the mods listed below from
`~/.config/herdr-app/`. To remove the hooks, delete the `bettr-reporter` entries from
`~/.claude/settings.json`.

## What gets installed

All of it is in this repo, under `mods/`. Nothing is downloaded.

| Mod | Origin |
|---|---|
| `my-files` | clone of Herdr's `files` 0.1.13, plus highlighting, diff view and Markdown (mine) |
| `my-changes` | clone of Herdr's `changes` 0.1.13, plus highlighting (mine) |
| `my-graph` | new (mine) |
| `my-spaces` | clone of Herdr's `spaces` 0.1.15, plus an agent icon after a space's name for each tab that runs an agent (mine) |
| `my-tabs` | clone of Herdr's `tabs` 0.1.13, plus the Graph, Activity, Context and History buttons (mine) |
| `bettr-activity`, `bettr-context`, `bettr-reporter` | [dissimulate/bettr](https://github.com/dissimulate/bettr); `bettr-context` and `bettr-reporter` have local additions for Pi and opencode, see [THIRD_PARTY.md](THIRD_PARTY.md) |
| `history`, `md-preview` | [plutotw/herdr-main-usage](https://github.com/plutotw/herdr-main-usage); `history` has a small patch |

Folder names must stay `bettr-*`: the hooks call the reporter by folder name. Sources, pinned commits,
what was changed, and licensing notes for the third-party mods are in [THIRD_PARTY.md](THIRD_PARTY.md).
`history` as upstream ships it polls every 20 seconds even while its tab is closed; the copy here polls
only while the tab is open and stops rewriting its cache file when nothing changed.

## What the mods run and read

None of the mods use the network, except that **Markdown links you click** (`http`, `https`, `mailto`)
open in your browser through `xdg-open` / `open`.

| Mod | Runs | Reads / writes |
|---|---|---|
| Files, Changes | `git`, `sh` | the focused pane's folder |
| Graph | `git`, `git-graph`, `sh` | the focused pane's repo; remembers the branch choice in the mod's `localStorage` |
| Activity, Context | nothing | terminal labels published by the reporter |
| Context for Pi and opencode | `python3 pull.py` (every 5 s while that agent is focused and the tab is open) | Pi's session files and model lists in `~/.pi/agent`, opencode's database and model cache (read only); keeps Pi's read position and opencode's last result in `~/.cache/bettr/pull/` (opencode is rebuilt only when a message or part changed) |
| reporter (only with `--hooks`) | `python3` and `hc label` from agent hooks | agent transcripts (read), `~/.cache/bettr/` (state). It stores the first line of prompts, file paths, commands and replies; credential-like values are masked. |
| History | `python3 history.py` | agent transcripts in `~/.claude`, `~/.codex`, `~/.pi` (read), `~/.cache/herdr-history/index.json` (cache). Resume runs `claude --resume`, `codex resume` or `pi --session`. |

## Layout

`layouts/my-layout.json` is Herdr's `main` layout with the right panel changed: `tabs` → `my-tabs`, `spaces` →
`my-spaces`, and
the panel's `panel-body` stack has six children in this order: `files`, `changes`, `graph`, `activity`,
`context`, `history`. Everything else is stock, so it follows Herdr's theme and your `settings.json`.

**Agents in the spaces list.** After a space's name there is one small icon for each of its tabs that runs an agent
(up to three, then `+N`). A dot on the icon shows what needs you, in the theme's working, blocked and done colours
(done: finished while you were away); an agent that reports idle is dimmed. Hover names the agent and its tab. A tab with
two agents shows the first. A space with no icon has no
agent running. Agents are Herdr's program table (`new-menu.agents`), so opencode counts although it never reports a
status; such an agent has no dot and is not dimmed, as nothing says whether it is busy. The narrow icon-only sidebar is unchanged.
Per-space panel memory comes from the stock tab bar logic, so each space reopens its own panel.

## Backing up changes

After editing the layout or mods in Herdr, copy them back into this repo and commit:

```sh
scripts/backup.sh          # live ~/.config/herdr-app -> this repo (layout + all mods)
git add -A && git commit -m "..." && git push
```

`gpui-kit.d.ts` and `jsconfig.json` in each mod folder are written by Herdr itself and are not stored.

## Tests

Plain Node, no dependencies. Each stubs Herdr's UI imports and exercises the pure logic:

```sh
node mods/my-changes/highlight.test.mjs   # tokenizer, diff rows, truncation, CRLF
node mods/my-files/files.test.mjs         # Markdown link resolution
node mods/my-changes/groups.test.mjs       # change tags, numstat merge, unpushed files
node mods/my-files/rollup.test.mjs        # folder marks and +/- totals
node mods/my-spaces/agents.test.mjs       # which tab runs which agent
node mods/my-graph/graph.test.mjs         # ANSI colours, branch parsing, git-graph arguments
node mods/my-changes/search.test.mjs      # matching, fuzzy names, rg/grep scripts (run with and without ripgrep)
(cd mods/bettr-reporter && python3 -m unittest test_pull test_redaction_patch)   # Pi and opencode context, redaction
node mods/bettr-context/model.test.mjs   # hook-less agents, stale labels
```

Run `herdr-app check mods/<name>` after any change; `herdr-app status` should show no errors.

## Known limits

- The Graph tab shows the latest 500 commits and polls every 3 seconds, only while the tab is open.
- `git-graph` ignores branch names unless a model is set, so a filtered graph always uses its `simple`
  model; an unfiltered graph uses your repo's own model.
- While a find query is set in the Files tab, the file is drawn as rows: no text selection or folding until
  the bar closes. A Markdown file is searched as source. The editor widget has no search of its own.
- History transcript find jumps to the message (the list restarts there) and marks it with a bar; it cannot
  highlight words inside a message. Transcript content search matches raw JSONL, so a phrase that spans an
  escaped quote or line break can be missed.
- The Files tab does not reload an open file when it changes on disk (use **↗** for a live Markdown
  preview); the Diff view does refresh.
- Activity, Context and History follow Claude Code, Codex and Pi transcripts and hooks, which are not
  stable APIs and may change.
- Context for Pi and opencode picks the newest session of the focused terminal's folder, so two sessions in one
  folder show the later one, and a new session shows the previous one until it writes its first message. It lags by up to
  5 seconds. Pi sessions are trees: the total is exact, but the rows also count branches you left. opencode's database has no
  system prompt or tool list, so that text is in Messages' `Other`; its compaction marker (an assistant message with
  `summary`) is taken from its message format and has not been seen in a real session here. Needs SQLite 3.38+ (Python 3.12 ships it).
  Pi's window size is found only for a managed Pi install and models it lists; otherwise tokens show without a percentage.

## Licence

The code in `mods/my-*` and `scripts/` is MIT (see `LICENSE`). `my-files`, `my-changes`, `my-tabs` and `my-spaces`
are derived from Herdr's shipped mods and keep whatever terms those carry. The other mods are other
people's work, copied with credit and no licence grant from their authors: see
[THIRD_PARTY.md](THIRD_PARTY.md).
