#!/usr/bin/env bash
# Build Claude-Desktop-<arch>.AppImage (+ .zsync) from Anthropic's .deb.
#
# Usage: appimage/build.sh <claude-desktop.deb> <x86_64|aarch64> <version> <outdir>
#
# Needs: APPIMAGETOOL (appimagetool AppImage for the build host),
#        UPDATETOOL (appimageupdatetool AppImage for the *target* arch),
#        NODE_PATH with @electron/asar 3.x, plus zsyncmake, unsquashfs, file.
set -euo pipefail

deb="$(realpath "$1")"
arch="$2"
version="$3"
out="$(realpath -m "$4")"
here="$(cd "$(dirname "$0")" && pwd)"
: "${APPIMAGETOOL:?}" "${UPDATETOOL:?}"

repo="${GITHUB_REPOSITORY:-nandi-conda/claude-desktop}"
name=Claude-Desktop
file="$name-$arch.AppImage"
# Fixed file name per arch: an update replaces the file in place, so menu
# entries and the in-app restart keep pointing at the right path.
update_info="gh-releases-zsync|${repo%%/*}|${repo#*/}|latest|$file.zsync"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
appdir="$work/AppDir"
mkdir -p "$appdir" "$work/deb" "$out"

echo "::group::Unpack .deb"
(cd "$work/deb" && ar x "$deb")
tar -xf "$work"/deb/data.tar.* -C "$appdir"
# /etc only registers Anthropic's apt repo.
rm -rf "$appdir/etc"
# Absolute symlinks (/usr/bin/claude-desktop -> /opt/...) must point into the AppDir.
find "$appdir" -type l | while read -r link; do
  target="$(readlink "$link")"
  case "$target" in
    /*) ln -sfn "$(realpath --relative-to="$(dirname "$link")" -m "$appdir$target")" "$link" ;;
  esac
done
find "$appdir" -maxdepth 4 -not -path '*/share/*' | sed "s|^$appdir||" | sort
echo "::endgroup::"

asar="$(find "$appdir" -path '*/resources/app.asar' -type f | head -n1)"
[ -n "$asar" ] || { echo "::error::no resources/app.asar in the .deb"; exit 1; }
edir="$(dirname "$(dirname "$asar")")"
echo "Electron app directory: ${edir#"$appdir"}"

exe=""
for f in "$edir"/*; do
  [ -f "$f" ] && [ -x "$f" ] || continue
  case "${f##*/}" in chrome-sandbox | chrome_crashpad_handler | *.so | *.so.*) continue ;; esac
  file -b "$f" | grep -q '^ELF' || continue
  exe="$f"
  case "${f##*/}" in *laude*) break ;; esac
done
[ -n "$exe" ] || { echo "::error::no Electron executable in ${edir#"$appdir"}"; exit 1; }
echo "Electron executable: ${exe#"$appdir"}"

# Prefer the upstream launcher when it's a script (it may set flags/env);
# rewrite its absolute install paths to the AppDir.
entry="${exe#"$appdir"/}"
launcher="$appdir/usr/bin/claude-desktop"
if [ -f "$launcher" ] && [ ! -L "$launcher" ] && [ "$(head -c2 "$launcher")" = '#!' ]; then
  echo "::group::Upstream launcher script"
  cat "$launcher"
  echo "::endgroup::"
  sed -i -E 's#(^|[^A-Za-z0-9_.$/-])/(opt|usr/lib|usr/share)/#\1${APPDIR}/\2/#g' "$launcher"
  echo "::group::Launcher after path rewrite"
  cat "$launcher"
  echo "::endgroup::"
  entry=usr/bin/claude-desktop
fi
echo "AppRun entry: $entry"

# Can't be setuid in an AppImage; without it Chromium uses the userns sandbox (see AppRun).
rm -f "$edir/chrome-sandbox"

echo "::group::Add in-app updater to app.asar"
node "$here/repack-asar.cjs" "$asar" "$here/updater.cjs" "$version" "$repo" "$file"
echo "::endgroup::"

echo "::group::Bundle appimageupdatetool"
# The tool is an AppImage itself; unpack it so it runs without FUSE and can be
# built for another arch. Its squashfs starts where the ELF runtime ends.
offset="$(python3 -c '
import struct, sys
h = open(sys.argv[1], "rb").read(64)
assert h[:4] == b"\x7fELF" and h[4] == 2, "not a 64-bit ELF"
shoff, = struct.unpack_from("<Q", h, 0x28)
shentsize, shnum = struct.unpack_from("<HH", h, 0x3A)
print(shoff + shentsize * shnum)' "$UPDATETOOL")"
mkdir -p "$appdir/usr/lib"
unsquashfs -q -n -o "$offset" -d "$appdir/usr/lib/appimageupdatetool" "$UPDATETOOL"
[ -e "$appdir/usr/lib/appimageupdatetool/AppRun" ] || { echo "::error::appimageupdatetool has no AppRun"; exit 1; }
ls -la "$appdir/usr/lib/appimageupdatetool"
echo "::endgroup::"

echo "::group::Desktop entry and icon"
desktop_src="$(grep -l '^Exec=.*claude' "$appdir"/usr/share/applications/*.desktop | head -n1)"
desktop="$appdir/claude-desktop.desktop"
cp "$desktop_src" "$desktop"
icon_name="$(sed -n 's/^Icon=//p' "$desktop" | head -n1)"
icon_base="${icon_name##*/}"
icon_base="${icon_base%.png}"
# Largest PNG with the icon's name (not the Electron binary, which shares it).
icon="$(find "$appdir/usr/share/icons" "$appdir/usr/share/pixmaps" -type f -name "$icon_base.png" 2>/dev/null \
  | xargs -r ls -S | while read -r f; do file -b "$f" | grep -q '^PNG' && { echo "$f"; break; }; done || true)"
[ -n "$icon" ] || { echo "::error::no PNG icon named $icon_base"; exit 1; }
cp "$icon" "$appdir/$icon_base.png"
file "$icon"
sed -i -E \
  -e "s|^Icon=.*|Icon=$icon_base|" \
  -e 's|^Exec=[^ ]+|Exec=claude-desktop|' \
  -e '/^TryExec=/d' \
  "$desktop"
sed -i "0,/^\[Desktop Entry\]/s//[Desktop Entry]\nX-AppImage-Version=$version/" "$desktop"
cat "$desktop"
echo "::endgroup::"

sed -e "s|@ENTRY@|$entry|" -e "s|@REPO@|$repo|" -e "s|@FILE@|$file|" "$here/AppRun" > "$appdir/AppRun"
chmod +x "$appdir/AppRun"

echo "::group::appimagetool"
rm -f "$out/$file" "$out/$file.zsync"
(cd "$out" && ARCH="$arch" VERSION="$version" APPIMAGE_EXTRACT_AND_RUN=1 \
  "$APPIMAGETOOL" --no-appstream -u "$update_info" "$appdir" "$out/$file")
echo "::endgroup::"

[ -f "$out/$file.zsync" ] || { echo "::error::appimagetool did not write $file.zsync (is zsyncmake installed?)"; exit 1; }
ls -la "$out"
echo "Update information: $update_info"
