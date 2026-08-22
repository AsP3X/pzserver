from align_map_info_skip import align


def test_skip_2_to_1_doubles_stored_size():
    info = {"w": 579616, "h": 253944, "skip": 2, "x0": 1040384}
    out = align(info, 1)
    assert out["skip"] == 1
    assert out["w"] == 1159232
    assert out["h"] == 507888
    assert out["x0"] == 1040384


def test_align_is_noop_when_skip_matches():
    info = {"w": 1159232, "h": 507888, "skip": 1}
    assert align(info, 1)["w"] == 1159232
