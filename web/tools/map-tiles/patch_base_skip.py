"""Do not paint vanilla lotpack on squares the save overlay owns.

Applied at image build against pzmap2dzi's BaseRender.square.
"""
from pathlib import Path

TARGET = Path("/opt/pzmap2dzi/pzmap2dzi/render_impl/base.py")

OLD = """    def square(self, im_getter, dzi, ox, oy, sx, sy, layer):
        oy += dzi.sqr_height >> 1  # center -> bottom center
        cx, subx = divmod(sx, dzi.cell_size)
"""

NEW = """    def square(self, im_getter, dzi, ox, oy, sx, sy, layer):
        oy += dzi.sqr_height >> 1  # center -> bottom center
        try:
            from save_skip import covers as _save_covers
            if _save_covers(sx, sy):
                return
        except Exception as error:
            if not getattr(self, '_save_skip_warned', False):
                print('save-square skip failed: {}'.format(error))
                self._save_skip_warned = True
        cx, subx = divmod(sx, dzi.cell_size)
"""


def apply(text: str) -> str:
    if "from save_skip import covers" in text:
        return text
    if OLD not in text:
        raise SystemExit("BaseRender.square not found — pzmap2dzi base render has changed")
    return text.replace(OLD, NEW, 1)


if __name__ == "__main__":
    target = Path(TARGET)
    if not target.is_file():
        raise SystemExit(f"missing {target}")
    target.write_text(apply(target.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"patched {target}")
