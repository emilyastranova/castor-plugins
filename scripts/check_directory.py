#!/usr/bin/env python3
"""Check directory.json the way Castor reads it, and each plugin it lists.

    python3 scripts/check_directory.py               # the file, and every plugin in this repository
    python3 scripts/check_directory.py --releases    # also each plugin's newest GitHub release
    python3 scripts/check_directory.py --releases --only-elsewhere   # just those in other repositories

Uses Castor's own checks (castor_server, installed from the Castor repository: CI does that), so a
plugin that passes here is one Castor accepts:
- the directory: unique ids, a known publisher, a repository on one of that publisher's GitHub accounts;
- a plugin in this repository: its folder packs into a release Castor reads (manifest, icon, library
  content), with the directory's id and publisher;
- with --releases: the newest release has its .zip and .zip.sha256, they match, and the manifest in
  it is the directory's id, publisher and the tag's version.
Exit 1 with every problem listed."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from pack import pack  # noqa: E402

try:
    from castor_server import plugin_directory as D
    from castor_server.plugin_package import read_zip
except ImportError:
    sys.exit("castor_server isn't installed: pip install -e <castor>/server (see README.md)")

THIS_REPO = "emilyastranova/castor-plugins"


def check_local(entry: D.Entry, problems: list[str]) -> None:
    folder = ROOT / entry.path
    if not (folder / "castor-plugin.yaml").is_file():
        problems.append(f"{entry.id}: no castor-plugin.yaml in {entry.path}")
        return
    with tempfile.TemporaryDirectory() as out:
        try:
            pkg = read_zip(pack(folder, Path(out)).read_bytes())
        except ValueError as exc:
            problems.append(f"{entry.id}: Castor refuses it: {exc}")
            return
    m = pkg.manifest
    if m.id != entry.id:
        problems.append(f"{entry.id}: its manifest says id {m.id}")
    if m.publisher != entry.publisher:
        problems.append(f"{entry.id}: its manifest says publisher {m.publisher or '(none)'}, the directory {entry.publisher}")
    if not entry.tag_prefix:
        problems.append(f"{entry.id}: a repository with several plugins needs tag_prefix ({entry.id}-v)")
    print(f"ok  {entry.id} {m.version} ({len(pkg.files)} files, {len(pkg.library)} library items)")


async def check_release(entry: D.Entry, problems: list[str]) -> None:
    try:
        data, release = await D.download(entry)
        pkg = read_zip(data)
    except (D.DirectoryError, ValueError) as exc:
        problems.append(f"{entry.id}: newest release: {exc}")
        return
    m = pkg.manifest
    if (m.id, m.publisher, m.version) != (entry.id, entry.publisher, release.version):
        problems.append(f"{entry.id}: release {release.tag} holds {m.id} {m.version} by {m.publisher or '(none)'}")
    else:
        print(f"ok  {entry.id} release {release.tag}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--releases", action="store_true", help="also check each plugin's newest GitHub release")
    ap.add_argument("--only-elsewhere", action="store_true",
                    help="with --releases: only plugins in other repositories (this one's are released after merging)")
    args = ap.parse_args()
    problems: list[str] = []
    try:
        directory = D.Directory.model_validate(json.loads((ROOT / "directory.json").read_text()))
    except ValueError as exc:
        sys.exit(f"directory.json: {exc}")
    for entry in directory.plugins:
        if entry.repo == THIS_REPO:
            check_local(entry, problems)
        elif entry.path:
            problems.append(f"{entry.id}: path is for plugins in this repository")
    listed = {e.path for e in directory.plugins if e.repo == THIS_REPO}
    for folder in sorted((ROOT / "plugins").iterdir()):
        if folder.is_dir() and f"plugins/{folder.name}" not in listed:
            problems.append(f"plugins/{folder.name}: not in directory.json")
    if args.releases:
        async def all_releases() -> None:
            for entry in directory.plugins:
                if not (args.only_elsewhere and entry.repo == THIS_REPO):
                    await check_release(entry, problems)
        asyncio.run(all_releases())
    if problems:
        print("\n".join(f"FAIL {p}" for p in problems), file=sys.stderr)
        sys.exit(1)
    print(f"directory.json: {len(directory.plugins)} plugins from {len(directory.publishers)} publishers")


if __name__ == "__main__":
    main()
