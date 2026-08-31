import io

from PIL import Image

from thumbs import cell_dzi_box, compose_overview, render_thumb, scale_stamp, thumb_scale


def test_thumb_scale_is_the_same_in_every_cell():
    left0, _t0, right0, _b0 = cell_dzi_box(0, 0)
    left1, _t1, right1, _b1 = cell_dzi_box(40, -12)
    assert right0 - left0 == right1 - left1
    assert abs(thumb_scale() - 512 / (right0 - left0)) < 1e-12


def test_compose_overview_returns_png():
    cell = Image.new("RGBA", (16, 16), (10, 20, 30, 255))
    buf = io.BytesIO()
    cell.save(buf, format="PNG")
    blob = compose_overview([(0, 0, buf.getvalue())])
    assert blob[:8] == b"\x89PNG\r\n\x1a\n"


def test_upper_storey_is_drawn_above_ground():
    image = Image.new("RGBA", (8, 8), (255, 0, 0, 255))
    ground = render_thumb([(4, 5, 0, image, 0, 0)], 0, 0)
    storey = render_thumb([(4, 5, 1, image, 0, 0)], 0, 0)
    assert ground is not None
    assert storey is not None
    assert ground != storey


def test_pre_scaled_stamp_matches_inline_resize():
    image = Image.new("RGBA", (64, 128), (10, 20, 30, 255))
    records = [(4, 5, 0, image, -3, -10)]
    naive = render_thumb(records, 0, 0)
    stamp = scale_stamp(image, thumb_scale())
    cached = render_thumb([(4, 5, 0, stamp, -3, -10)], 0, 0, pre_scaled=True)
    assert naive == cached
    assert naive is not None
    assert len(naive) > 0
