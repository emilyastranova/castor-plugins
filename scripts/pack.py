#!/usr/bin/env python3
"""Pack a plugin folder into the .zip Castor installs (Settings → Plugins → Install plugin).

    python3 scripts/pack.py plugins/nessus-import            # → dist/nessus-import-1.0.0.zip
    python3 scripts/pack.py plugins/nessus-import --out x/   # somewhere else

Leaves out what only matters while working on it: tests (*_test.ts), samples/, deno.json, dist/.
The same files always give the same .zip (fixed timestamps, sorted), so a release's SHA-256 can be
checked against a fresh pack. Standard library only."""

from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {"samples", "dist", "node_modules", ".git"}
SKIP_FILES = {"deno.json", "deno.lock", ".DS_Store"}


def manifest_field(folder: Path, name: str) -> str:
    text = (folder / "castor-plugin.yaml").read_text()
    found = re.search(rf"^{name}:\s*[\"']?([^\"'\s#]+)", text, re.M)
    if not found:
        sys.exit(f"{folder}/castor-plugin.yaml needs {name}:")
    return found[1]


def files_of(folder: Path) -> list[Path]:
    out = []
    for path in sorted(folder.rglob("*")):
        rel = path.relative_to(folder)
        if not path.is_file() or path.is_symlink() or rel.parts[0] in SKIP_DIRS:
            continue
        if path.name.endswith("_test.ts") or path.name in SKIP_FILES:
            continue
        out.append(path)
    return out


def pack(folder: Path, out_dir: Path | None = None) -> Path:
    folder = folder.resolve()
    pid, version = manifest_field(folder, "id"), manifest_field(folder, "version")
    out = (out_dir or ROOT / "dist") / f"{pid}-{version}.zip"
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in files_of(folder):
            info = zipfile.ZipInfo(path.relative_to(folder).as_posix(), date_time=(2020, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, path.read_bytes())
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()
    print(pack(args.folder, args.out))
