from save_skip import covers


def test_covers_an_8_square_chunk():
    rects = [(8704, 7680, 8, 8)]
    assert covers(8704, 7680, rects)
    assert covers(8711, 7687, rects)
    assert not covers(8712, 7680, rects)
    assert not covers(8704, 7688, rects)


def test_empty_rects_cover_nothing():
    assert not covers(8704, 7680, [])
