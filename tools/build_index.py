"""Scan levels/<pack>/level_<pack>_<idx>.txt and write web/levels_index.json.

A pack is either a board size ("6".."12", all boards that size) or one of the
mixed-size packs "hard" / "bad", whose board size is read from each file.
The web client only needs to know how many levels each pack has (files are
numbered sequentially from 1).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEVELS_DIR = ROOT / "levels"
OUT_PATH = ROOT / "web" / "levels_index.json"

# Freshly generated levels that need backtracking land here; they are triaged
# into the hard/bad packs rather than shipped from this directory.
SKIP_DIRS = {"backtrack"}


def main():
    counts: dict[str, int] = {}
    for pack_dir in sorted(LEVELS_DIR.iterdir()):
        if not pack_dir.is_dir() or pack_dir.name in SKIP_DIRS:
            continue
        pattern = re.compile(rf"level_{re.escape(pack_dir.name)}_(\d+)\.txt$")
        indices = [
            int(m.group(1))
            for path in pack_dir.glob("level_*.txt")
            if (m := pattern.match(path.name))
        ]
        if indices:
            counts[pack_dir.name] = max(indices)

    OUT_PATH.write_text(json.dumps(counts, indent=2, sort_keys=True) + "\n")
    print(f"wrote {OUT_PATH}: {counts}")


if __name__ == "__main__":
    main()
