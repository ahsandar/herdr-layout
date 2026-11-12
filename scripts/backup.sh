#!/bin/sh
# Copies the layout and all mods from the live Herdr config folder back into this repo.
# Run it after changing them in Herdr, then commit. HERDR_APP_HOME overrides the config folder.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
cp "$home/layouts/my-layout.json" "$here/layouts/"
for m in my-files my-changes my-graph my-tabs my-spaces bettr-activity bettr-context bettr-reporter history md-preview; do
  rm -rf "$here/mods/$m"; mkdir -p "$here/mods/$m"
  # gpui-kit.d.ts and jsconfig.json are written by Herdr itself
  (cd "$home/mods/$m" && find . -type f ! -name gpui-kit.d.ts ! -name jsconfig.json ! -path '*/__pycache__/*' -print0 | tar --null -T - -cf -) | tar -xf - -C "$here/mods/$m"
done
echo "Copied from $home. Review with: git -C $here status"
