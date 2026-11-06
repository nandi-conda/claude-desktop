# claude-desktop conda package

Repackages Anthropic's Claude desktop `.deb` for Linux
([docs](https://code.claude.com/docs/en/desktop-linux)) as a conda package and
publishes it to the `nandi-testing` channel on prefix.dev.

`.github/workflows/publish.yml` runs daily (and on demand from the Actions tab).
For `linux-64` and `linux-aarch64` it reads the apt repository from the docs page,
picks the newest version, skips it if prefix.dev already has it, and otherwise
builds `recipe/` with rattler-build and uploads it using the `PREFIX_API_KEY` secret.

```
pixi global install -c https://prefix.dev/nandi-testing claude-desktop
```

The package ships a [menuinst](https://conda.github.io/menuinst/) shortcut in
`$PREFIX/Menu/claude-desktop.json`, so conda and `pixi global` add Claude to the
desktop app launcher on install. It is generated at build time from the `.desktop`
file inside the `.deb` (see `recipe/menu.jq`).

## AppImage

The AppImage builds on the [fileapi forge](https://fileapi.fastapicloud.dev/forge/#nandi.uk/claude-desktop)
(`nandi.uk/claude-desktop`), not GitHub Actions. `.forge/jobs.toml` runs `ci/appimage.py` on every push
to `main`: it resolves the newest `.deb` for amd64 and arm64, builds `appimage/Dockerfile` on Depot for
each arch, and publishes `Claude-Desktop-x86_64.AppImage` and `Claude-Desktop-aarch64.AppImage` (each with
a `.zsync`) as release `v<version>` on the forge. A version that is already released is skipped; bump
`appimage/REVISION` to republish it, or press **Run now** on the forge's Deploys tab to pick up a new
upstream version without a push. The job needs a `DEPOT_TOKEN` secret (a user secret
from `just depot-user-token` works). `DEPOT_PROJECT_ID` is optional: without it the job uses the Depot
project named `claude-desktop`, creating it if needed.

```
curl -fLO https://fileapi.fastapicloud.dev/api/forge/repos/nandi.uk/claude-desktop/releases/latest/assets/Claude-Desktop-x86_64.AppImage
chmod +x Claude-Desktop-x86_64.AppImage
./Claude-Desktop-x86_64.AppImage
```

The AppImage updates itself from the latest forge release:

- **Help › Check for Updates…** (the app's own item, which on Linux otherwise just points at apt) and a
  **Check for Updates…** tray item run the AppImage updater.
- About 30 seconds after start-up, and every 6 hours, the app checks and offers to update. The new
  AppImage replaces the old file in place and the app offers to restart into it.
- `./Claude-Desktop-x86_64.AppImage --appimage-update` updates from a terminal.

The release's `.zsync` file is the update feed: its header carries the latest AppImage's file name and
SHA-1. The forge doesn't serve range requests, so an update downloads the whole file and checks it
against that SHA-1. The embedded update information (`zsync|<url>`) lets AppImageLauncher and Gear Lever
see updates too.

`CLAUDE_APPIMAGE_NO_AUTO_CHECK=1` keeps the menu item but skips background checks;
`CLAUDE_APPIMAGE_DISABLE_UPDATES=1` turns the updater off.

How it works (`appimage/`): `build.sh` unpacks the `.deb` into an AppDir, adds `updater.cjs` to
`app.asar` as the new entry point (it wires the menu items, then loads the app's original `main`), and
runs `appimagetool -u`. `chrome-sandbox` is dropped because it can't be setuid in an AppImage; `AppRun`
adds `--no-sandbox` only where unprivileged user namespaces are blocked (for example Ubuntu's AppArmor
default) or when running as root, so Chromium's namespace sandbox is used elsewhere.
