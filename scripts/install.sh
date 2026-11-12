#!/bin/sh
# Installs this layout and its mods into Herdr's config folder (default ~/.config/herdr-app).
# Everything it installs is in this repo: nothing is downloaded.
#
#   scripts/install.sh [--update] [--own-only] [--hooks]
#
#   --update     replace mods and the layout that are already installed (the old ones are moved to
#                <home>/.backups/herdr-layout-<time>/, never deleted)
#   --own-only   install only Files, Changes, Graph, the tab bar and the spaces list; skip Activity, Context, History
#                and the Markdown pane
#   --hooks      also install the agent hooks that feed Activity and Context. This edits
#                ~/.claude/settings.json (and ~/.codex/hooks.json); off unless you ask.
#
# HERDR_APP_HOME overrides the config folder. herdr-app on PATH is used to check each mod.
set -eu

OWN_MODS="my-files my-changes my-graph my-tabs my-spaces"
MORE_MODS="bettr-activity bettr-context bettr-reporter history md-preview"
LAYOUT=my-layout

update=0 more=1 hooks=0
for arg in "$@"; do
  case "$arg" in
    --update) update=1 ;;
    --own-only) more=0 ;;
    --hooks) hooks=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
[ "$hooks" = 1 ] && [ "$more" = 0 ] && { echo "--hooks needs the Activity/Context mods (drop --own-only)" >&2; exit 2; }

here=$(cd "$(dirname "$0")/.." && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
backup="$home/.backups/herdr-layout-$(date +%Y%m%d-%H%M%S)"
mods=$OWN_MODS; [ "$more" = 1 ] && mods="$OWN_MODS $MORE_MODS"
mkdir -p "$home/mods" "$home/layouts"

# an existing target is an error unless --update; then it is moved aside first
place() {
  src=$1 dst=$2
  if [ -e "$dst" ]; then
    [ "$update" = 1 ] || { echo "already installed: $dst (use --update to replace it)" >&2; exit 1; }
    mkdir -p "$backup"; mv "$dst" "$backup/"
  fi
  cp -R "$src" "$dst"
}

echo "Installing into $home"
for m in $mods; do
  # the tests are for development, not for Herdr
  place "$here/mods/$m" "$home/mods/$m"
  find "$home/mods/$m" \( -name '*.test.mjs' -o -name 'test_*' \) -delete
done
place "$here/layouts/$LAYOUT.json" "$home/layouts/$LAYOUT.json"

if command -v herdr-app >/dev/null 2>&1; then
  for m in $mods; do
    [ -f "$home/mods/$m/main.js" ] && herdr-app check "$home/mods/$m"
  done
else
  echo "herdr-app not found on PATH: skipped the mod checks"
fi

[ "$hooks" = 1 ] && python3 -I "$home/mods/bettr-reporter/setup.py" install
[ -d "$backup" ] && echo "Replaced files were moved to $backup"
cat <<MSG

Done. Switch to the layout:   herdr-app do layout.switch '{"name":"$LAYOUT"}'
Switch back with ctrl-shift-l. The Graph tab needs git-graph:   cargo install git-graph
Activity and Context stay empty until the hooks are installed:   scripts/install.sh --update --hooks
Search: every tab has a search button; for a key, add to the "global" section of $home/keys.json:
  "ctrl-alt-f": "my-tabs.search"
MSG
