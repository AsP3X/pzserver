"""Fail a render whose tile cache filled up.

The levels `omit_levels` discards are rendered but never written to disk --
they live only in the shared-memory cache, and the level below is merged from
them. When the cache is full, `release_cache` asks the worker to save a tile
to make room, and `save_tile` returns 'skip' for exactly those levels
(pzdzi.py:127). The tile is destroyed rather than spilled, and its parent
merges the missing quadrant as black.

So the number that matters is the peak, not the hit rate. Measured:

  limit 4096, peak 4112  -> ceiling reached, ~13,000 tiles destroyed
  limit 16384, peak 5760 -> never evicted, no holes

Cache *misses* are not the signal. `merge_tile` falls back to `load_tile` on a
miss, which recovers any tile that was written to disk; both runs above missed
~3.7% and only the first lost data.

  python check_cache.py render.log <cache_limit_mb>
"""
import re
import sys
from pathlib import Path

PEAK = re.compile(r"cache max used:\s*([0-9.]+)\s*MB")

# A peak this close to the ceiling means eviction either ran or was about to.
# The figure is a high-water sample, so treat the margin as the safe signal.
SAFE_FRACTION = 0.95


def main(log_path: str, limit_mb: int) -> int:
    text = Path(log_path).read_text(encoding="utf-8", errors="replace").replace("\r", "\n")
    peaks = PEAK.findall(text)

    if not peaks:
        if "map_info mismatch" in text or "Render stopped" in text:
            print(
                "FAIL: pzmap2dzi stopped before painting (map_info mismatch).\n"
                "The on-disk map_info.json w/h/skip did not match the size it\n"
                "computed from the game files. run.sh now drops that file before\n"
                "render so it can write a fresh one.",
                file=sys.stderr,
            )
            return 1
        print(
            "FAIL: the render never reported its peak cache use.\n"
            "Without it there is no way to tell whether tiles were evicted and\n"
            "destroyed, so this run cannot be trusted.",
            file=sys.stderr,
        )
        return 1

    peak = float(peaks[-1])
    ceiling = limit_mb * SAFE_FRACTION

    if peak >= ceiling:
        print(
            f"FAIL: cache peaked at {peak:.0f} MB against a {limit_mb} MB limit.\n\n"
            f"At the ceiling the render evicts tiles to make room. The deepest\n"
            f"levels are never written to disk, so evicting one destroys it and\n"
            f"its parent merges a black quadrant -- holes in the map.\n\n"
            f"Raise cache_limit_mb in web/tools/map-tiles/conf.yaml, and shm_size\n"
            f"in docker-compose.web.yml above it, then render again.",
            file=sys.stderr,
        )
        return 1

    print(f"cache peaked at {peak:.0f} MB of {limit_mb} MB - nothing evicted")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: check_cache.py <render log> <cache_limit_mb>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1], int(sys.argv[2])))
