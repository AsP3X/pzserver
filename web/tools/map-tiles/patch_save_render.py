"""Hook door/window sprite selection into pzmap2dzi's save renderer.

pzdataspec is downloaded at render time into /out/lib. We cannot patch it at
image build. We can patch save.py's init_worker so that once utils loads, it
swaps ChunkData.__init__ for the one in chunk_sprites.py.
"""
from pathlib import Path

TARGET = Path("/opt/pzmap2dzi/pzmap2dzi/render_impl/save.py")

OLD = """    def init_worker(self, dzi):
        self.utils = self.lib_loader.load('pzdataspec.utils')
        self.tiledef = self.utils.load_tile_defs(self.pz_root, self.mod_root, self.save_version)
"""

NEW = """    def init_worker(self, dzi):
        self.utils = self.lib_loader.load('pzdataspec.utils')
        try:
            from chunk_sprites import patch_chunk_data
            patch_chunk_data(self.utils)
        except Exception as error:
            print('door/window sprite patch skipped: {}'.format(error))
        self.tiledef = self.utils.load_tile_defs(self.pz_root, self.mod_root, self.save_version)
"""


def apply(text: str) -> str:
    if "from chunk_sprites import patch_chunk_data" in text:
        return text
    if OLD not in text:
        raise SystemExit("save.py init_worker not found — pzmap2dzi save render has changed")
    return text.replace(OLD, NEW, 1)


if __name__ == "__main__":
    target = Path(TARGET)
    if not target.is_file():
        raise SystemExit(f"missing {target}")
    target.write_text(apply(target.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"patched {target}")
