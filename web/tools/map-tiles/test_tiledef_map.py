from pathlib import Path

from tiledef_map import expand_sheet, merge_into, read_map, sibling_name, split_name, write_map


def test_split_and_sibling():
    assert split_name("fixtures_doors_01_0") == ("fixtures_doors_01", 0)
    assert sibling_name("fixtures_doors_01_0", 2) == "fixtures_doors_01_2"
    assert split_name("nope") is None


def test_one_anchor_maps_only_that_id():
    """A lotpack match is evidence about one id, not about the 511 after it.

    Stamping a whole 512-wide page from one anchor claimed ids belonging to
    floors, walls and vegetation as door tiles, and the overlay then drew those
    objects as doors and windows all over the map.
    """
    mapping: dict[int, str] = {}
    expand_sheet(mapping, 11264, "fixtures_doors_01_0")
    assert mapping == {11264: "fixtures_doors_01_0"}
    assert 11266 not in mapping
    assert 11264 + 57 not in mapping


def test_an_unsplittable_name_still_maps_its_id():
    mapping: dict[int, str] = {}
    expand_sheet(mapping, 42, "nope")
    assert mapping == {42: "nope"}


def test_confirmed_id_overwrites_a_collision():
    mapping: dict[int, str] = {}
    expand_sheet(mapping, 11264, "fixtures_doors_01_0")
    expand_sheet(mapping, 11266, "fixtures_doors_01_2")
    assert mapping[11266] == "fixtures_doors_01_2"


def test_round_trip_file(tmp_path: Path):
    dest = tmp_path / "map.txt"
    write_map(dest, {11264: "fixtures_doors_01_0", 16384: "fixtures_windows_01_0"})
    assert read_map(dest)[11264] == "fixtures_doors_01_0"


def test_merge_overwrites_the_wrong_sheet():
    tiledef = {11264: "floors_overlay_street_01_0"}
    n = merge_into(tiledef, {11264: "fixtures_doors_01_0"})
    assert n == 1
    assert tiledef[11264] == "fixtures_doors_01_0"
