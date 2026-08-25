"""Let conf.yaml choose the render margin instead of the jumbo-tree flag.

`render_margin` decides how far outside a tile pzmap2dzi looks for squares
whose sprite reaches into it. 'normal' assumes a 128x256 texture and works
out to (left, top, right, bottom) = (0, 0, 0, 6): **no horizontal reach at
all**, and six grid rows -- 192 px -- of upward reach. 'large' assumes
384x512 and gives (-2, 0, 2, 14).

Both named sizes are too small for B42. Knox County places JUMBOXL trees in
the lotpack and the texture is 515x727 -- it reaches 259 px left and 729 px
up from its square, past 'large' in both axes. A tree standing outside the
tile is therefore never considered while painting the tiles its canopy
covers, and the canopy is chopped along a straight line: the
rectangle-over-a-tree, baked into the shipped county pack and reproduced by
every redraw. conf.yaml carries an explicit numeric margin sized for it.

BaseRender.update_options overwrites render_margin unconditionally, so a
value in render_conf never survives. Make it a default instead.
"""
from pathlib import Path
import sys

TARGET = Path("/opt/pzmap2dzi/pzmap2dzi/render_impl/base.py")

OLD = """    def update_options(self, options):
        options['render_margin'] = 'large' if self.use_jumbo_tree else 'normal'
        return options
"""

NEW = """    def update_options(self, options):
        # conf.yaml wins; jumbo trees still force 'large' when it says nothing.
        if not options.get('render_margin'):
            options['render_margin'] = 'large' if self.use_jumbo_tree else 'normal'
        return options
"""


def apply(text: str) -> str:
    if "conf.yaml wins" in text:
        return text
    if OLD not in text:
        raise SystemExit(
            "BaseRender.update_options not found — pzmap2dzi base render has changed"
        )
    return text.replace(OLD, NEW, 1)


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else TARGET
    if not path.is_file():
        raise SystemExit(f"missing {path}")
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
