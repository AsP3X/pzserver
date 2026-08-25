"""Downsample parent tiles with BOX, not LANCZOS.

pzmap2dzi builds each DZI level by pasting four children and
`thumbnail(..., Image.LANCZOS)`. LANCZOS rings at a hard edge: a 1-pixel
bright line on the z20 tile at rows 509, 1021, 1533 — the z22 child
boundaries, 512 px apart. BOX is the 2x2 box filter for an exact 2x
downsample and does not overshoot.

Applied at image build against pzdzi.merge_tile. Fails the build if
upstream moved the call.
"""
from pathlib import Path

TARGET = Path("/opt/pzmap2dzi/pzmap2dzi/pzdzi.py")

OLD = """            tile.thumbnail((self.tile_size, self.tile_size), Image.LANCZOS)
"""

NEW = """            tile.thumbnail((self.tile_size, self.tile_size), Image.BOX)
"""


def apply(text: str) -> str:
    if "thumbnail((self.tile_size, self.tile_size), Image.BOX)" in text:
        return text
    if OLD not in text:
        raise SystemExit("merge_tile thumbnail not found — pzmap2dzi merge has changed")
    return text.replace(OLD, NEW, 1)


if __name__ == "__main__":
    target = Path(TARGET)
    if not target.is_file():
        raise SystemExit(f"missing {target}")
    target.write_text(apply(target.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"patched {target}")
