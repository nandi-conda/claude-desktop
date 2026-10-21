"""Find the newest claude-desktop .deb for one architecture.

Reads the apt repository URL from the desktop-linux docs page, then picks the
highest Version in that repository's Packages index. Prints KEY=VALUE lines
suitable for $GITHUB_OUTPUT.
"""
import re
import subprocess
import sys
import urllib.request
from functools import cmp_to_key

DOCS_URL = "https://code.claude.com/docs/en/desktop-linux.md"


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read().decode()


def dpkg_cmp(a, b):
    if a == b:
        return 0
    lt = subprocess.run(["dpkg", "--compare-versions", a, "lt", b]).returncode == 0
    return -1 if lt else 1


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
