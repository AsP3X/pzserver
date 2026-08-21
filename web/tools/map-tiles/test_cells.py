import json

from cells import Geometry, cell_rect_to_tiles


GEO = Geometry(x0=1_040_384, y0=-139_296, sqr=128, cell_size=256, tile_size=2048, max_level=22)


def test_a_single_cell_maps_to_the_tiles_that_cover_it():
    tiles = cell_rect_to_tiles(GEO, [(34, 30, 1, 1)], levels=[20])

    assert tiles, "a real cell must land on at least one tile"
    # Every returned tile must actually overlap the cell's DZI bounding box.
    span = GEO.tile_size * 2 ** (GEO.max_level - 20)
    lo_x, lo_y, hi_x, hi_y = GEO.cell_rect_bounds(34, 30, 1, 1)
    for z, tx, ty in tiles:
        assert z == 20
        assert tx * span <= hi_x and (tx + 1) * span >= lo_x
        assert ty * span <= hi_y and (ty + 1) * span >= lo_y


def test_a_bigger_region_covers_more_tiles_than_a_smaller_one():
    small = cell_rect_to_tiles(GEO, [(34, 30, 1, 1)], levels=[20])
    big = cell_rect_to_tiles(GEO, [(34, 30, 8, 8)], levels=[20])

    assert small < big or len(big) > len(small)


def test_shallow_levels_collapse_onto_fewer_tiles():
    deep = cell_rect_to_tiles(GEO, [(34, 30, 4, 4)], levels=[20])
    shallow = cell_rect_to_tiles(GEO, [(34, 30, 4, 4)], levels=[16])

    assert len(shallow) < len(deep)


def test_every_level_requested_is_represented():
    tiles = cell_rect_to_tiles(GEO, [(34, 30, 2, 2)], levels=[18, 19, 20])

    assert {z for z, _, _ in tiles} == {18, 19, 20}


def test_geometry_can_be_read_from_map_info(tmp_path):
    info = tmp_path / "map_info.json"
    info.write_text(json.dumps({"x0": 1_040_384, "y0": -139_296, "sqr": 128, "cell_size": 256}))

    geo = Geometry.from_map_info(info)

    assert (geo.x0, geo.y0, geo.sqr, geo.cell_size) == (1_040_384, -139_296, 128, 256)


def test_merge_inputs_are_the_siblings_the_pyramid_needs():
    """Rebuilding a parent means merging its four children. Re-rendering one
    child without its three siblings on disk gives a parent that is three
    quarters black, which is precisely the bug this whole exercise started
    from."""
    from cells import merge_inputs

    targets = {(19, 4, 6)}
    needed = merge_inputs(targets, deepest=20)

    # the four children of (19,4,6) live at level 20
    assert needed == {(20, 8, 12), (20, 9, 12), (20, 8, 13), (20, 9, 13)}


def test_merge_inputs_exclude_tiles_that_are_themselves_being_rerendered():
    from cells import merge_inputs

    targets = {(19, 4, 6), (20, 8, 12)}
    needed = merge_inputs(targets, deepest=20)

    assert (20, 8, 12) not in needed, "a target is redrawn, not restored"
    assert (20, 9, 12) in needed


def test_merge_inputs_stop_at_the_deepest_rendered_level():
    from cells import merge_inputs

    needed = merge_inputs({(20, 8, 12)}, deepest=20)

    assert needed == set(), "level 20 has no children to merge from"
