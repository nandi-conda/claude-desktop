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
