from lotpack_leaves import (
    is_curtain,
    is_door_leaf,
    is_stump,
    is_thumpable_leaf,
    is_tree_leaf,
    is_wall_leaf,
    is_window_leaf,
    leaves_for,
)


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


def test_tree_leaf_keeps_canopies_and_stumps():
    assert is_tree_leaf("vegetation_trees_01_3")
    assert is_tree_leaf("jumbo_tree_01_0")
    assert is_tree_leaf("e_redmapleJUMBOXL_1_3")
    assert is_tree_leaf("e_americanhollyJUMBO_1_0")
    assert is_tree_leaf("vegetation_trees_01_stump")
    assert not is_tree_leaf("vegetation_foliage_01_0")
    assert not is_tree_leaf("blends_natural_01_0")


def test_wall_leaf_drops_overlays():
    assert is_wall_leaf("walls_exterior_house_01_0")
    assert is_wall_leaf("walls_interior_house_01_4")
    assert not is_wall_leaf("walls_exterior_house_overlay_01_0")
    assert not is_wall_leaf("floors_interior_tilesandwood_01_23")


def test_thumpable_leaf_is_carpentry_not_vanilla_walls():
    assert is_thumpable_leaf("constructedobjects_01_12")
    assert is_thumpable_leaf("carpentry_02_4")
    assert is_thumpable_leaf("crafted_01_0")
    assert not is_thumpable_leaf("walls_exterior_house_01_0")
    assert not is_thumpable_leaf("fixtures_doors_01_0")


def test_stump_name():
    assert is_stump("d_generic_1_stump")
    assert not is_stump("vegetation_trees_01_3")


def test_leaves_for_tree_and_thumpable():
    tiles = [
        "blends_natural_01_0",
        "vegetation_trees_01_3",
        "constructedobjects_01_12",
        "walls_exterior_house_01_0",
    ]
    assert leaves_for("tree", tiles) == ["vegetation_trees_01_3"]
    assert leaves_for("thumpable", tiles) == ["constructedobjects_01_12"]
    assert leaves_for("wall", tiles) == ["walls_exterior_house_01_0"]
