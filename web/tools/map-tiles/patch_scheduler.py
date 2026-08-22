"""Pin skip-level tiles so LRU eviction cannot destroy them.

pzmap2dzi's omit_levels + shared-memory cache is the combination that paints
black rectangles into the isometric map. The deepest levels are rendered but
never written to disk; a parent merges from whatever is still in the cache.
When the cache fills, scheduling.py pops the LRU entry and asks the worker to
save it. save_tile returns 'skip' for those levels, so the tile is gone, and
the parent merges a missing quadrant as black (JPEG has no alpha).

Upstream's own default is enable_cache: false, and they added a dedicated
commit (cfb29a55 "support omit levels with cache off") so omit_levels works
without the cache. We keep the cache for speed, but refuse to evict a tile
whose parent is still pending.

This script is applied at image build against the cloned pzmap2dzi tree. It
fails the build if upstream moved the eviction loop, rather than silently
shipping the old bug.
"""
from pathlib import Path
import sys

TARGET = Path("/opt/pzmap2dzi/pzmap2dzi/scheduling.py")

EVICT_OLD = """                if self.cache_size:
                    while self.cache_used > self.cache_size:
                        self.release_cache(None, 'save')
"""

EVICT_NEW = """                if self.cache_size:
                    while self.cache_used > self.cache_size:
                        if not self.release_unpinned():
                            break
"""

METHOD_OLD = """    def release_cache(self, key, method):
        if key:
            hit_key, value = self.lru.pop(key)
        else:
            hit_key, value = self.lru.pop()
        if hit_key:
            wid, layer_map = value
            if self.stopped[wid] == 0:
                self.context.send_msg(wid, (method, hit_key))
            self.cache_used -= sum(layer_map)

    def shutdown(self):
"""

METHOD_NEW = """    def release_cache(self, key, method):
        if key:
            hit_key, value = self.lru.pop(key)
        else:
            hit_key, value = self.lru.pop()
        if hit_key:
            wid, layer_map = value
            if self.stopped[wid] == 0:
                self.context.send_msg(wid, (method, hit_key))
            self.cache_used -= sum(layer_map)

    def release_unpinned(self):
        # Evict the oldest cache entry whose parent is already done.
        # omit_levels keeps the deepest tiles only in shared memory. LRU
        # eviction of one of those before its parent merges paints a black
        # quadrant. Skip those; if every entry is still needed, stop rather
        # than destroying work. The cache may then grow past cache_limit_mb
        # until parents complete and drop their children.
        key = self.lru.head
        while key is not None:
            if self.get_thumbnail_task(key) is None:
                self.release_cache(key, 'save')
                return True
            _value, _pre, nxt = self.lru.m[key]
            key = nxt
        return False

    def shutdown(self):
"""


def apply(text: str) -> str:
    if "def release_unpinned(self):" in text:
        return text
    if EVICT_OLD not in text:
        raise SystemExit("eviction loop not found — pzmap2dzi scheduling.py has changed")
    if METHOD_OLD not in text:
        raise SystemExit("release_cache not found — pzmap2dzi scheduling.py has changed")
    text = text.replace(EVICT_OLD, EVICT_NEW, 1)
    text = text.replace(METHOD_OLD, METHOD_NEW, 1)
    return text


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else TARGET
    original = path.read_text(encoding="utf-8")
    patched = apply(original)
    if patched == original:
        print(f"already patched: {path}")
        return 0
    path.write_text(patched, encoding="utf-8")
    print(f"patched: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
