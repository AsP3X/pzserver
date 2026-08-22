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


def test_tiles_expand_back_to_every_cell_they_touch():
    """render_cell_range paints only the cells named. A tile straddling the
    edge of that range therefore comes back part-painted and part-black -- it
    fixed one hole and cut a bigger one. So the cells asked for have to be
    widened to whole tiles before rendering."""
    from cells import expand_to_whole_tiles

    asked = [(39, 36, 1, 1)]
    widened = expand_to_whole_tiles(GEO, asked, level=20)

    # the original cell must still be in there
    covered = set()
    for cx, cy, w, h in widened:
        for x in range(cx, cx + w):
            for y in range(cy, cy + h):
                covered.add((x, y))
    assert (39, 36) in covered

    # and it must genuinely widen: one cell is smaller than a level-20 tile
    assert len(covered) > 1


def test_widening_covers_the_tiles_it_claims_to():
    from cells import cell_rect_to_tiles, expand_to_whole_tiles

    asked = [(39, 36, 1, 1)]
    target_tiles = cell_rect_to_tiles(GEO, asked, levels=[20])
    widened = expand_to_whole_tiles(GEO, asked, level=20)

    # every target tile must be fully inside the widened cell area
    widened_tiles = cell_rect_to_tiles(GEO, widened, levels=[20])
    assert target_tiles <= widened_tiles


def test_a_square_rect_maps_to_tiles_that_cover_it():
    from cells import square_rect_to_tiles

    tiles = square_rect_to_tiles(GEO, [(8704, 7680, 256, 256)], levels=[20])
    assert tiles
    span = GEO.span(20)
    lo_x, lo_y, hi_x, hi_y = GEO.square_rect_bounds(8704, 7680, 256, 256)
    for z, tx, ty in tiles:
        assert z == 20
        assert tx * span <= hi_x and (tx + 1) * span >= lo_x
        assert ty * span <= hi_y and (ty + 1) * span >= lo_y


def test_a_cell_rect_is_the_same_as_its_square_box():
    from cells import cells_as_squares, cell_rect_to_tiles, square_rect_to_tiles

    cells = [(34, 30, 1, 1)]
    from_cells = cell_rect_to_tiles(GEO, cells, levels=[20])
    from_squares = square_rect_to_tiles(GEO, cells_as_squares(GEO, cells), levels=[20])
    assert from_cells == from_squares


def test_dirty_set_includes_every_packed_ancestor():
    from cells import dirty_pyramid

    leaves = {(20, 8, 12)}
    dirty = dirty_pyramid(leaves, max_level=20, min_level=0)
    assert (20, 8, 12) in dirty
    assert (19, 4, 6) in dirty
    assert (0, 0, 0) in dirty
    assert len([t for t in dirty if t[0] == 20]) == 1


def test_plan_from_squares_dirties_every_packed_level():
    from region import plan
    from cells import cells_as_squares

    squares = cells_as_squares(GEO, [(34, 30, 1, 1)])
    targets, restore, render_cells = plan(GEO, squares, min_level=0, max_level=20)
    assert {z for z, _, _ in targets} == set(range(0, 21))
    assert restore
    assert restore.isdisjoint(targets)
    assert render_cells
