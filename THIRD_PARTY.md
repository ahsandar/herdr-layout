# Third-party code

Some mods in `mods/` were written by other people. They are copied here unchanged (except where noted)
so this repo is a complete, self-contained backup that does not depend on those projects staying online.
Each project's licence is its author's to set: **neither project ships a licence file at the commits
below**, so the copies here carry no licence grant from their authors. Credit and the original repos
are listed so you can ask the authors, and so you can swap in a licensed version.

| Mods here | Original | Taken at commit | Changes made here |
|---|---|---|---|
| `bettr-activity`, `bettr-context`, `bettr-reporter` | [dissimulate/bettr](https://github.com/dissimulate/bettr) | `7a025db895473397ee63a74e9ea848b2059894e8` | `bettr-reporter` only: search patterns and every agent name/description are now run through `redact()` (`providers/classify.py` `entry`, `providers/common.py` `agent`), so credential-like text is masked before it is published as a label. Covers the Claude and Codex providers. Upstream's 54 tests still pass on the patched code; `test_redaction_patch.py` covers the patch. Upstream's own tests and `.md` docs are left out. |
| `history`, `md-preview` | [plutotw/herdr-main-usage](https://github.com/plutotw/herdr-main-usage) | `ee244edf49da251c276d615abb614d29ffbb5ef0` | `history`: its tab polls only while open (`visible()` check in `main.js`), and `history.py` rewrites its cache file only when a transcript changed, and keeps `~/.cache/herdr-history` private (folder 0700, index file 0600; upstream leaves them world-readable). Search was added too: a **Transcripts** chip (searches inside transcripts with ripgrep or grep), find inside an open transcript, and `search.js` (my code, MIT, shared with the `my-*` mods). `md-preview`: none. |

Icons: `activity.svg`, `gauge.svg` and the icons in `bettr-activity/icons` and `bettr-context/icons` are
from [Lucide](https://lucide.dev), ISC licence (`LICENSE-Lucide.txt` sits beside them).

Derived from Herdr's own mods: `my-files`, `my-changes` and `my-tabs` started as clones (`mod.clone`) of
Herdr 0.1.13's `files`, `changes` and `tabs`, and `layouts/my-layout.json` as a clone of `main`.

If you are an author of one of these projects and want a copy removed or a licence line added, open an
issue on this repo.
