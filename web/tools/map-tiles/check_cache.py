"""Fail a render that silently lost tiles.

pzmap2dzi keeps the deepest levels only in a shared-memory cache -- with
`omit_levels` set they are never written to disk. Evicting one destroys it:
`release_cache` asks the worker to save, and `save_tile` returns 'skip' for
exactly those levels. The tile's parent then merges a missing quadrant as
black.

A cache miss is therefore not a performance note, it is data loss. The render
still exits 0, still passes the geometry gate, and still packs cleanly -- the
damage only shows up as black rectangles on the map, hours later.

  python check_cache.py render.log
"""
import re
import sys
from pathlib import Path

PATTERN = re.compile(r"cache hit:\s*(\d+)\s*/\s*(\d+)")


def main(log_path: str) -> int:
    text = Path(log_path).read_text(encoding="utf-8", errors="replace")
    matches = PATTERN.findall(text.replace("\r", "\n"))

    if not matches:
        print(
            "FAIL: the render never reported a cache hit rate.\n"
            "Without it there is no way to tell whether deep tiles were evicted\n"
            "and lost, so this run cannot be trusted.",
            file=sys.stderr,
        )
        return 1

    hits, gets = (int(v) for v in matches[-1])
    misses = gets - hits

    if misses > 0:
        print(
            f"FAIL: {misses} cache misses out of {gets}.\n\n"
            f"Each miss is a tile that was evicted before its parent could merge\n"
            f"it. The deepest levels are never written to disk, so those tiles are\n"
            f"gone and their parents have black quadrants -- holes in the map.\n\n"
            f"Raise cache_limit_mb in web/tools/map-tiles/conf.yaml (and shm_size\n"
            f"in docker-compose.web.yml above it), then render again.",
            file=sys.stderr,
        )
        return 1

    print(f"cache: {hits}/{gets} hits, no tiles lost")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: check_cache.py <render log>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
