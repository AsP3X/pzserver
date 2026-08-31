from iso import dzi_to_world, square_anchor, world_to_dzi


def test_origin_matches_iso_dzi():
    x, y = world_to_dzi(0, 0)
    assert x == 1_040_384
    assert y == -139_296


def test_round_trip():
    px, py = world_to_dzi(10723, 9765)
    wx, wy = dzi_to_world(px, py)
    assert abs(wx - 10723) < 1e-6
    assert abs(wy - 9765) < 1e-6


def test_neighbour_is_one_diamond():
    x0, y0 = world_to_dzi(0, 0)
    x1, y1 = world_to_dzi(1, 0)
    assert x1 - x0 == 64
    assert y1 - y0 == 32


def test_square_anchor_is_bottom_centre():
    ax, ay = square_anchor(0, 0)
    tx, ty = world_to_dzi(0, 0)
    assert ax == int(tx)
    assert ay == int(ty) + 64
