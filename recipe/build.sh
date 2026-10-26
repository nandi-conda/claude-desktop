#!/usr/bin/env bash
set -euxo pipefail

work="$(mktemp -d)"
cd "$work"
ar x "$SRC_DIR/claude-desktop.deb"
mkdir root
tar -xf data.tar.* -C root

# /usr maps onto the prefix; anything under /opt keeps its layout under $PREFIX/opt.
# /etc is skipped: it only registers Anthropic's apt repo.
[ -d root/usr ] && cp -a root/usr/. "$PREFIX/"
[ -d root/opt ] && mkdir -p "$PREFIX/opt" && cp -a root/opt/. "$PREFIX/opt/"

# Re-point absolute symlinks (e.g. /usr/bin/claude-desktop -> /opt/...) into the prefix.
find "$PREFIX" -type l | while read -r link; do
  target="$(readlink "$link")"
  case "$target" in
    /usr/*) new="$PREFIX/${target#/usr/}" ;;
    /opt/*) new="$PREFIX$target" ;;
    *) continue ;;
  esac
  ln -sfn "$(realpath --relative-to="$(dirname "$link")" -m "$new")" "$link"
done

# menuinst shortcut: conda / pixi global read $PREFIX/Menu/*.json and create the
# launcher entry themselves. Name, WM class, MIME types and icon are taken from
# the .desktop file the .deb ships so the shortcut matches the native install.
desktop="$(grep -l '^Exec=.*claude' root/usr/share/applications/*.desktop | head -n1)"
field() { sed -n "s/^$1=//p" "$desktop" | head -n1; }
list() { printf "%s\n" "$(field "$1")" | jq -Rc 'split(";") | map(select(length > 0))'; }

icon_name="$(field Icon)"
icon="$( (find root/usr/share/icons root/usr/share/pixmaps root/opt \
  \( -name "${icon_name##*/}.png" -o -name "${icon_name##*/}" \) -type f 2>/dev/null || true) \
  | xargs -r ls -S | head -n1)"

test -x "$PREFIX/bin/claude-desktop"
mkdir -p "$PREFIX/Menu"
cp "$icon" "$PREFIX/Menu/claude-desktop.png"
jq -n \
  --arg name "$(field Name)" \
  --arg desc "$(field Comment)" \
  --arg wmclass "$(field StartupWMClass)" \
  --argjson categories "$(list Categories)" \
  --argjson mime "$(list MimeType)" \
  -f "$RECIPE_DIR/menu.jq" > "$PREFIX/Menu/claude-desktop.json"
cat "$PREFIX/Menu/claude-desktop.json"
