#!/usr/bin/env python3
"""Release every plugin in plugins/ whose version has no GitHub release yet (CI, on main).

    python3 scripts/release.py --dry-run      # what it would release
    GH_TOKEN=… python3 scripts/release.py     # pack and publish them with the gh CLI

A release is tagged <id>-v<version> (the directory's tag_prefix) and carries what Castor reads:
<id>-<version>.zip, <id>-<version>.zip.sha256, castor-plugin.yaml, README.md and the icon. Bump
`version:` in a plugin's castor-plugin.yaml to release it again; a released version is never
replaced (installed copies are checked against its SHA-256)."""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from pack import manifest_field, pack  # noqa: E402


def tags() -> set[str]:
    out = subprocess.run(["gh", "release", "list", "--limit", "1000", "--json", "tagName", "--jq", ".[].tagName"],
                         capture_output=True, text=True, check=True, cwd=ROOT).stdout
    return set(out.split())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    released = tags()
    for folder in sorted(p for p in (ROOT / "plugins").iterdir() if (p / "castor-plugin.yaml").is_file()):
        pid, version = manifest_field(folder, "id"), manifest_field(folder, "version")
        tag = f"{pid}-v{version}"
        if tag in released:
            continue
        print(f"release {tag}")
        if args.dry_run:
            continue
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            zipped = pack(folder, out)
            sha = out / f"{zipped.name}.sha256"
            sha.write_text(f"{hashlib.sha256(zipped.read_bytes()).hexdigest()}  {zipped.name}\n")
            files = [zipped, sha]
            for name in ("castor-plugin.yaml", "README.md", "icon.svg", "icon.png", "icon.webp"):
                if (folder / name).is_file():
                    files.append(Path(shutil.copy(folder / name, out / name)))
            notes = f"{pid} {version}. Install it from Castor: Settings → Plugins → Browse."
            subprocess.run(["gh", "release", "create", tag, "--title", f"{pid} {version}", "--notes", notes,
                            *[str(f) for f in files]], check=True, cwd=ROOT)


if __name__ == "__main__":
    main()
