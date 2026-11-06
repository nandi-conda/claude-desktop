"""Find the newest claude-desktop .deb for one architecture.

Reads the apt repository URL from the desktop-linux docs page, then picks the
highest Version in that repository's Packages index. Prints KEY=VALUE lines
suitable for $GITHUB_OUTPUT.
"""
import re
import shutil
import subprocess
import sys
import urllib.request
from functools import cmp_to_key

DOCS_URL = "https://code.claude.com/docs/en/desktop-linux.md"


def fetch(url):
    # The docs site rejects urllib's default User-Agent.
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode()


def _order(c):
    # dpkg: ~ sorts before everything (even the end), letters before non-letters.
    if c == "~":
        return -1
    if c.isdigit():
        return 0
    if c.isalpha():
        return ord(c)
    return ord(c) + 256


def _cmp_part(a, b):
    while a or b:
        # non-digit prefix
        i = 0
        while i < len(a) and not a[i].isdigit():
            i += 1
        j = 0
        while j < len(b) and not b[j].isdigit():
            j += 1
        pa, pb = a[:i], b[:j]
        a, b = a[i:], b[j:]
        for k in range(max(len(pa), len(pb))):
            ca = _order(pa[k]) if k < len(pa) else 0
            cb = _order(pb[k]) if k < len(pb) else 0
            if ca != cb:
                return -1 if ca < cb else 1
        # digit prefix
        i = 0
        while i < len(a) and a[i].isdigit():
            i += 1
        j = 0
        while j < len(b) and b[j].isdigit():
            j += 1
        na, nb = int(a[:i] or 0), int(b[:j] or 0)
        a, b = a[i:], b[j:]
        if na != nb:
            return -1 if na < nb else 1
    return 0


def _split(v):
    epoch, _, rest = v.rpartition(":") if ":" in v else ("0", "", v)
    upstream, _, revision = rest.rpartition("-") if "-" in rest else (rest, "", "")
    return int(epoch or 0), upstream, revision


def dpkg_cmp(a, b):
    if a == b:
        return 0
    if shutil.which("dpkg"):
        lt = subprocess.run(["dpkg", "--compare-versions", a, "lt", b]).returncode == 0
        return -1 if lt else 1
    # No dpkg (the fileapi forge runner): Debian's algorithm in Python.
    ea, ua, ra = _split(a)
    eb, ub, rb = _split(b)
    if ea != eb:
        return -1 if ea < eb else 1
    return _cmp_part(ua, ub) or _cmp_part(ra, rb)


def main(arch):
    docs = fetch(DOCS_URL)
    m = re.search(r"https://[^\s\"']+/claude-desktop/apt/stable", docs)
    if not m:
        sys.exit(f"no apt repository URL found on {DOCS_URL}")
    repo = m.group(0)

    index = fetch(f"{repo}/dists/stable/main/binary-{arch}/Packages")
    stanzas = []
    for block in index.split("\n\n"):
        fields = dict(re.findall(r"^([\w-]+): (.*)$", block, re.M))
        if fields.get("Package") == "claude-desktop":
            stanzas.append(fields)
    if not stanzas:
        sys.exit(f"no claude-desktop package in {repo} for {arch}")
    latest = max(stanzas, key=cmp_to_key(lambda a, b: dpkg_cmp(a["Version"], b["Version"])))

    # conda versions can't carry a dpkg epoch, '-' or '~'.
    version = re.sub(r"[-~]", "_", re.sub(r"^\d+:", "", latest["Version"]))
    print(f"deb_version={latest['Version']}")
    print(f"version={version}")
    print(f"url={repo}/{latest['Filename']}")
    print(f"sha256={latest['SHA256']}")


if __name__ == "__main__":
    main(sys.argv[1])
