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


def test_region_cli_writes_keep_and_leaves(tmp_path):
    import json
    import subprocess
    import sys
    from pathlib import Path

    info = tmp_path / "map_info.json"
    info.write_text(
        json.dumps({"x0": GEO.x0, "y0": GEO.y0, "sqr": GEO.sqr, "cell_size": 256}),
        encoding="utf-8",
    )
    out = tmp_path / "out"
    out.mkdir()
    here = Path(__file__).resolve().parent
    subprocess.check_call(
        [sys.executable, str(here / "region.py"), str(info), "10496,9728,256,256", "0", "20", str(out)],
    )
    keep_z = {int(line.split("/")[0]) for line in (out / "keep.txt").read_text().split()}
    leaf_z = {int(line.split("/")[0]) for line in (out / "leaves.txt").read_text().split()}
    assert 20 not in keep_z
    assert 19 in keep_z
    assert leaf_z == {20}
    assert (out / "dirty.txt").read_text()
    assert (out / "restore.txt").read_text()


def test_plan_from_squares_dirties_every_packed_level():
    from region import plan
    from cells import cells_as_squares

    squares = cells_as_squares(GEO, [(34, 30, 1, 1)])
    targets, restore, render_cells, keep = plan(GEO, squares, min_level=0, max_level=20)
    assert {z for z, _, _ in targets} == set(range(0, 21))
    assert restore
    assert restore.isdisjoint(targets)
    assert render_cells == [(33, 29, 3, 3)]
    assert keep
    assert keep == {t for t in targets if t[0] < 20}
    assert keep.isdisjoint(restore)


def test_plan_detail_dirties_only_the_new_level():
    from region import plan_detail
    from cells import cells_as_squares

    squares = cells_as_squares(GEO, [(34, 30, 1, 1)])
    targets, restore, render_cells = plan_detail(GEO, squares, detail_level=21)
    assert {z for z, _, _ in targets} == {21}
    assert targets
    assert restore
    assert 20 in {z for z, _, _ in restore}
    assert 0 in {z for z, _, _ in restore}
    assert restore.isdisjoint(targets)
    assert render_cells


def test_distant_towns_are_separate_cell_boxes_not_the_forest_between():
    from region import plan_detail
    from cells import cells_as_squares

    squares = cells_as_squares(GEO, [(40, 36, 1, 1), (29, 43, 1, 1)])
    targets, restore, render_cells = plan_detail(GEO, squares, detail_level=21)
    assert len(render_cells) == 2
    # A single AABB around both towns would be tens of cells on a side.
    for _x, _y, w, h in render_cells:
        # Covering cells plus a 1-cell pad. Still a town, not the forest
        # between two towns (that AABB is hundreds of cells).
        assert w * h < 80, render_cells
    assert {z for z, _, _ in targets} == {21}


def test_covering_cells_world_box_contains_every_tile_pixel():
    """A DZI tile is a square; a cell is a diamond. If any sample of that
    square falls outside the covering cell box, JPEG fills it with black —
    the giant rectangle around cell 41,38 on the player map."""
    from cells import covering_cells_for_tiles, dzi_to_world

    asked = [(41, 38, 1, 1)]
    tiles = cell_rect_to_tiles(GEO, asked, levels=[20])
    widened = covering_cells_for_tiles(GEO, tiles, 20)
    span = GEO.span(20)
    s = GEO.cell_size

    def inside(wx, wy) -> bool:
        return any(
            cx * s <= wx <= (cx + w) * s and cy * s <= wy <= (cy + h) * s
            for cx, cy, w, h in widened
        )

    for _z, tx, ty in tiles:
        samples = [
            (tx * span, ty * span),
            ((tx + 1) * span - 1, ty * span),
            (tx * span, (ty + 1) * span - 1),
            ((tx + 1) * span - 1, (ty + 1) * span - 1),
            ((tx + 0.5) * span, (ty + 0.5) * span),
            ((tx + 0.5) * span, ty * span),
            ((tx + 0.5) * span, (ty + 1) * span - 1),
            (tx * span, (ty + 0.5) * span),
            ((tx + 1) * span - 1, (ty + 0.5) * span),
        ]
        for px, py in samples:
            wx, wy = dzi_to_world(GEO, px, py)
            assert inside(wx, wy), (tx, ty, px, py, wx, wy, widened)


def test_exact_cell_boundary_uses_floor_plus_one_not_ceil():
    """The cell containing world coordinate N.0 is cell N. `ceil(N.0) == N`
    drops it from a half-open [lo, hi). This geometry's y0 offset rarely
    lands on an integer, so the formula is asserted directly."""
    import math

    def hi(max_c: float) -> int:
        return math.floor(max_c) + 1

    assert hi(41.25) == 42
    assert hi(42.0) == 43
    assert math.ceil(42.0) == 42, "ceil is the bug this formula replaces"


def test_world_change_plan_reads_neighbour_squares_but_does_not_pack_their_tiles():
    """A tree in 40,40 hangs into 41,40. render_cell_range must include 40,40
    or the canopy is chopped along the cell edge. Packing 40,40's own tiles
    is the old 5×5 bug: fresh JPEGs that never lined up with the pack."""
    from region import plan
    from cells import cell_rect_to_tiles, cells_as_squares

    squares = cells_as_squares(GEO, [(41, 38, 1, 1)])
    targets, _restore, render_cells, _keep = plan(GEO, squares, min_level=0, max_level=20)
    assert render_cells == [(40, 37, 3, 3)]
    asked = cell_rect_to_tiles(GEO, [(41, 38, 1, 1)], [20])
    padded = cell_rect_to_tiles(GEO, [(40, 37, 3, 3)], [20])
    got = {t for t in targets if t[0] == 20}
    assert got == asked
    assert len(got) < len(padded)


def test_inflate_grows_a_cell_box_without_going_negative():
    from cells import inflate_cell_rects

    assert inflate_cell_rects([(41, 38, 1, 1)], pad=1) == [(40, 37, 3, 3)]
    assert inflate_cell_rects([(0, 0, 1, 1)], pad=1) == [(0, 0, 2, 2)]
    assert inflate_cell_rects([(41, 38, 1, 1)], pad=0) == [(41, 38, 1, 1)]
