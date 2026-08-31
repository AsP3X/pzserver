"""Pack unique sprite bitmaps onto atlas pages."""

from __future__ import annotations

from dataclasses import dataclass

from PIL import Image

PAGE = 2048
PAD = 1


@dataclass(frozen=True)
class PackedSprite:
    name: str
    page: int
    x: int
    y: int
    w: int
    h: int
    ox: int
    oy: int


def pack(
    sprites: list[tuple[str, Image.Image, int, int]],
) -> tuple[list[Image.Image], list[PackedSprite]]:
    """`sprites` is (name, rgba image, ox, oy)."""
    pages: list[Image.Image] = []
    packed: list[PackedSprite] = []
    page = Image.new("RGBA", (PAGE, PAGE), (0, 0, 0, 0))
    cursor_x = PAD
    cursor_y = PAD
    row_h = 0
    page_index = 0

    ordered = sorted(sprites, key=lambda item: (-item[1].size[1], -item[1].size[0], item[0]))
    for name, image, ox, oy in ordered:
        w, h = image.size
        if w <= 0 or h <= 0:
            continue
        if w + PAD * 2 > PAGE or h + PAD * 2 > PAGE:
            image = image.crop((0, 0, min(w, PAGE - PAD * 2), min(h, PAGE - PAD * 2)))
            w, h = image.size
        if cursor_x + w + PAD > PAGE:
            cursor_x = PAD
            cursor_y += row_h + PAD
            row_h = 0
        if cursor_y + h + PAD > PAGE:
            pages.append(page)
            page = Image.new("RGBA", (PAGE, PAGE), (0, 0, 0, 0))
            page_index += 1
            cursor_x = PAD
            cursor_y = PAD
            row_h = 0
        page.paste(image, (cursor_x, cursor_y))
        packed.append(
            PackedSprite(
                name=name,
                page=page_index,
                x=cursor_x,
                y=cursor_y,
                w=w,
                h=h,
                ox=ox,
                oy=oy,
            )
        )
        cursor_x += w + PAD
        row_h = max(row_h, h)

    if packed:
        pages.append(page)
    return pages, packed
