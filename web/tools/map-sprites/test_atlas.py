from PIL import Image

from atlas import pack


def test_packs_two_sprites_on_one_page():
    red = Image.new("RGBA", (8, 8), (255, 0, 0, 255))
    blue = Image.new("RGBA", (4, 12), (0, 0, 255, 255))
    pages, packed = pack([("red", red, -4, -8), ("blue", blue, -2, -12)])
    assert len(pages) == 1
    names = {item.name: item for item in packed}
    assert names["red"].w == 8
    assert names["red"].ox == -4
    assert names["blue"].page == 0
    pixel = pages[0].getpixel((names["red"].x, names["red"].y))
    assert pixel[0] == 255
