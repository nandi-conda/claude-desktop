"""fileapi forge job: build the AppImages on Depot and publish them as a release.

Runs from .forge/jobs.toml on the forge runner, which has python3 and the
Depot CLI but no curl or Docker. Steps:

1. Resolve the newest claude-desktop .deb for amd64 and arm64.
2. Skip if release v<version>[-<REVISION>] is already published (bump
   appimage/REVISION to republish the same upstream version).
3. For each arch: `depot build` appimage/Dockerfile with the .deb as build
   args, export the AppImage + .zsync to ./dist, upload both to a draft
   release, delete them locally (the runner's disk is small).
4. Publish the release; `latest` then serves the new files to the updater.

Needs DEPOT_TOKEN (repo or user secret). DEPOT_PROJECT_ID is optional: without it the
Depot project named claude-desktop is used, created if missing. FORGE_API and
FORGE_TOKEN come from the job.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import resolve_release  # noqa: E402

API = os.environ["FORGE_API"].rstrip("/")
TOKEN = os.environ["FORGE_TOKEN"]
PIECE = 32 * 1024 * 1024  # upload in pieces: keeps each request small
ARCHES = [("x86_64", "amd64"), ("aarch64", "arm64")]


def say(*a):
    print(*a, flush=True)


def api(method, path, body=None, data=None, headers=None):
    url = API + path
    hdrs = {"Authorization": f"Bearer {TOKEN}", **(headers or {})}
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw[:1] in (b"{", b"[") else raw)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def resolve(arch):
    """resolve_release.main prints KEY=VALUE lines; capture them."""
    import contextlib
    import io

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        resolve_release.main(arch)
    return dict(line.split("=", 1) for line in buf.getvalue().splitlines() if "=" in line)


def upload(tag, path):
    name = path.name
    size = path.stat().st_size
    sha = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            sha.update(chunk)
    digest = sha.hexdigest()
    say(f"Uploading {name} ({size / 1048576:.1f} MiB)")
    with open(path, "rb") as f:
        offset = 0
        while True:
            piece = f.read(PIECE)
            final = offset + len(piece) >= size
            q = {"offset": offset, "final": "true" if final else "false"}
            if final:
                q["sha256"] = digest
            status, out = api("PUT", f"/releases/{tag}/assets/{urllib.parse.quote(name)}?"
                              + urllib.parse.urlencode(q), data=piece,
                              headers={"Content-Type": "application/octet-stream"})
            if status >= 300:
                sys.exit(f"upload of {name} failed at offset {offset}: HTTP {status} {out}")
            offset += len(piece)
            if final:
                break
    say(f"  done, sha256 {digest}")


DEPOT_PROJECT = "claude-desktop"  # used when DEPOT_PROJECT_ID isn't set


def depot_project():
    """DEPOT_PROJECT_ID if set; else find (or create) the Depot project by name.

    With a Depot user token as a user secret, the repo needs no secrets of its own."""
    if os.environ.get("DEPOT_PROJECT_ID"):
        return os.environ["DEPOT_PROJECT_ID"]

    def projects():
        r = subprocess.run(["depot", "projects", "list", "--output", "json"], capture_output=True, text=True,
                           stdin=subprocess.DEVNULL)
        if r.returncode != 0:
            sys.exit(f"DEPOT_PROJECT_ID isn't set and `depot projects list` failed: {r.stderr.strip()[-500:]}")
        data = json.loads(r.stdout or "[]")
        if isinstance(data, dict):
            data = data.get("projects") or data.get("Projects") or []
        out = {}
        for p in data:
            low = {k.lower().replace("_", ""): v for k, v in p.items()} if isinstance(p, dict) else {}
            if low.get("projectid") or low.get("id"):
                out[str(low.get("name") or "")] = str(low.get("projectid") or low.get("id"))
        return out

    found = projects().get(DEPOT_PROJECT)
    if not found:
        say(f"Creating Depot project {DEPOT_PROJECT}")
        r = subprocess.run(["depot", "projects", "create", DEPOT_PROJECT], capture_output=True, text=True,
                           stdin=subprocess.DEVNULL)
        if r.returncode != 0:
            sys.exit(f"`depot projects create {DEPOT_PROJECT}` failed: {(r.stderr or r.stdout).strip()[-500:]}. "
                     "Set DEPOT_PROJECT_ID on this repo instead.")
        found = projects().get(DEPOT_PROJECT)
        if not found:
            sys.exit(f"Created Depot project {DEPOT_PROJECT} but can't find it; set DEPOT_PROJECT_ID instead.")
    say(f"Depot project {DEPOT_PROJECT}: {found}")
    return found


def main():
    if not os.environ.get("DEPOT_TOKEN"):
        sys.exit("DEPOT_TOKEN isn't set. In a fileapi checkout run `just depot-user-token claude-desktop` "
                 "(or set DEPOT_TOKEN as a user or repo secret).")
    project = depot_project()

    info = {deb: resolve(deb) for _, deb in ARCHES}
    for deb, i in info.items():
        say(f"{deb}: {i['deb_version']} {i['url']}")
    version = info["amd64"]["version"]
    arches = [(a, d) for a, d in ARCHES if info[d]["version"] == version]
    if len(arches) != len(ARCHES):
        say(f"warning: arm64 is at {info['arm64']['version']}, amd64 at {version}; building x86_64 only")

    rev = (ROOT / "appimage" / "REVISION").read_text().strip()
    tag = f"v{version}" + (f"-{rev}" if rev != "0" else "")
    status, rel = api("GET", f"/releases/{tag}")
    if status == 200 and not rel.get("draft"):
        say(f"Release {tag} is already published; nothing to do. Bump appimage/REVISION to rebuild.")
        return
    if status == 200:
        say(f"Removing unfinished draft {tag}")
        api("DELETE", f"/releases/{tag}")

    notes = f"""Claude Desktop {version} for Linux, repackaged as an AppImage from Anthropic's .deb.

Download `Claude-Desktop-x86_64.AppImage` (or `-aarch64`), `chmod +x` it and run it. It updates itself:
**Help › Check for Updates…**, the tray menu, the prompt shortly after start-up, or
`--appimage-update` from a terminal.

Built from {os.environ.get('FORGE_SHA', '')[:12]}.
"""
    status, out = api("POST", "/releases", body={"tag": tag, "name": f"Claude Desktop {version}",
                                                 "notes": notes, "draft": True})
    if status >= 300:
        sys.exit(f"creating release {tag} failed: HTTP {status} {out}")

    update_base = f"{API}/releases/latest/assets"
    dist = ROOT / "dist"
    for arch, deb in arches:
        shutil.rmtree(dist, ignore_errors=True)
        cmd = ["depot", "build", "--project", project, "--progress", "plain",
               "--platform", "linux/amd64", "-f", "appimage/Dockerfile",
               "--build-arg", f"ARCH={arch}", "--build-arg", f"VERSION={version}",
               "--build-arg", f"DEB_URL={info[deb]['url']}", "--build-arg", f"DEB_SHA256={info[deb]['sha256']}",
               "--build-arg", f"UPDATE_BASE={update_base}",
               "--output", f"type=local,dest={dist}", "."]
        say("$ " + " ".join(cmd))
        # The job keeps only 64 KiB of output, so show the build log's tail, not all of it.
        log = ROOT / f"depot-{arch}.log"
        with open(log, "wb") as f:
            code = subprocess.run(cmd, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT).returncode
        lines = log.read_text("utf-8", "replace").splitlines()
        say("\n".join([l for l in lines if "depot.dev/orgs/" in l][:1] + ["..."] + lines[-60:]))
        if code != 0:
            sys.exit(f"depot build for {arch} failed (exit {code})")
        files = sorted(dist.iterdir())
        say("Built: " + ", ".join(f"{p.name} ({p.stat().st_size} B)" for p in files))
        if {p.name for p in files} != {f"Claude-Desktop-{arch}.AppImage", f"Claude-Desktop-{arch}.AppImage.zsync"}:
            sys.exit("unexpected build output")
        for p in files:
            upload(tag, p)
        shutil.rmtree(dist, ignore_errors=True)

    status, out = api("PATCH", f"/releases/{tag}", body={"draft": False})
    if status >= 300:
        sys.exit(f"publishing {tag} failed: HTTP {status} {out}")
    say(f"Published {tag}: {os.environ.get('FORGE_URL', '')}/forge/#{os.environ.get('FORGE_REPO', '')}")


if __name__ == "__main__":
    main()
