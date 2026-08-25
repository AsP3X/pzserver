from lotpack_leaves import is_curtain, is_door_leaf, is_window_leaf, leaves_for


def test_door_leaf_keeps_the_door_and_drops_the_frame():
    assert is_door_leaf("fixtures_doors_01_57")
    assert is_door_leaf("fixtures_doors_fences_01_5")
    assert not is_door_leaf("fixtures_doors_frames_01_0")
    assert not is_door_leaf("lighting_indoor_01_25")


def test_window_leaf_drops_detailing():
    assert is_window_leaf("fixtures_windows_01_24")
    assert is_window_leaf("fixtures_windows_curtains_01_52")
    assert is_window_leaf("fixtures_windows_wood_14")
    assert not is_window_leaf("fixtures_windows_detailing_01_17")


def test_curtain_is_the_curtain_tile():
    assert is_curtain("fixtures_windows_curtains_01_52")
    assert not is_curtain("fixtures_windows_01_24")


def test_leaves_for_picks_the_door_not_the_frame():
    tiles = [
        "floors_interior_tilesandwood_01_23",
        "fixtures_doors_frames_01_0",
        "fixtures_doors_01_0",
        "lighting_indoor_01_2",
    ]
    assert leaves_for("door", tiles) == ["fixtures_doors_01_0"]
