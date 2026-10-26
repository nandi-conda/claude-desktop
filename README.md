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
