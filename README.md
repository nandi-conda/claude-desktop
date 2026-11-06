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

`.github/workflows/appimage.yml` also packages each new version as a self-updating
AppImage and publishes it as a [GitHub release](https://github.com/nandi-conda/claude-desktop/releases/latest)
(`Claude-Desktop-x86_64.AppImage`, `Claude-Desktop-aarch64.AppImage`, each with a `.zsync`).

```
curl -fLO https://github.com/nandi-conda/claude-desktop/releases/latest/download/Claude-Desktop-x86_64.AppImage
chmod +x Claude-Desktop-x86_64.AppImage
./Claude-Desktop-x86_64.AppImage
```

Updates come from the latest release as zsync deltas (`gh-releases-zsync` update
information is embedded in the AppImage, so AppImageLauncher, Gear Lever and
`appimageupdatetool` work too). Inside the app:

- **Check for Updates…** is added to the Help menu and the tray menu.
- About 30 seconds after start-up, and every 6 hours, the app checks and offers
  to update. The new AppImage replaces the old file in place and the app offers
  to restart into it.
- `./Claude-Desktop-x86_64.AppImage --appimage-update` updates from a terminal.

`CLAUDE_APPIMAGE_NO_AUTO_CHECK=1` keeps the menu item but skips background
checks; `CLAUDE_APPIMAGE_DISABLE_UPDATES=1` turns the updater off.

How it works (`appimage/`): `build.sh` unpacks the `.deb` into an AppDir, adds
`updater.cjs` to `app.asar` as the new entry point (it adds the menu items, then
loads the app's original `main`), bundles an unpacked `appimageupdatetool`, and
runs `appimagetool -u`. `chrome-sandbox` is dropped because it can't be setuid in
an AppImage; `AppRun` adds `--no-sandbox` only where unprivileged user namespaces
are blocked (for example Ubuntu's AppArmor default), so Chromium's namespace
sandbox is used elsewhere. The workflow runs daily, on pushes that touch
`appimage/`, and on demand, and skips versions that already have a release; bump
`appimage/REVISION` to republish the same upstream version.
