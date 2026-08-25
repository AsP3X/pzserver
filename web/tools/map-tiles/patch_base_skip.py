"""Do not paint the one vanilla sprite the save overrides.

Applied at image build against pzmap2dzi's BaseRender.square.

An earlier version returned from `square` outright, which dropped the floor
and the wall along with the door and left a black notch the save layer could
not fill — the save chunk stores the door, not the lotpack geometry. Filter
the tile list instead.
"""
from pathlib import Path

TARGET = Path("/opt/pzmap2dzi/pzmap2dzi/render_impl/base.py")

OLD = """        for t in tiles:
            tex = self.tl.get_by_name(t)
"""

NEW = """        try:
            from save_skip import suppressed as _save_suppressed
            _drop = _save_suppressed(sx, sy)
        except Exception as error:
            _drop = ()
            if not getattr(self, '_save_skip_warned', False):
                print('save-square skip failed: {}'.format(error))
                self._save_skip_warned = True
        for t in tiles:
            if t in _drop:
                continue
            tex = self.tl.get_by_name(t)
"""


def apply(text: str) -> str:
    if "from save_skip import suppressed" in text:
        return text
    if OLD not in text:
        raise SystemExit("BaseRender.square tile loop not found — pzmap2dzi base render has changed")
    return text.replace(OLD, NEW, 1)


if __name__ == "__main__":
    target = Path(TARGET)
    if not target.is_file():
        raise SystemExit(f"missing {target}")
    target.write_text(apply(target.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"patched {target}")
