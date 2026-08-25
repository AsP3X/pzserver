import pytest

from save_skip import parse, suppressed


def test_parse_groups_sprites_by_square():
    mapping = parse(
        "10496,9728,walls_doors_01_12\n"
        "10496,9728,walls_windows_01_4\n"
        "10497,9728,walls_doors_01_13\n"
    )
    assert mapping[(10496, 9728)] == frozenset(
        {"walls_doors_01_12", "walls_windows_01_4"}
    )
    assert mapping[(10497, 9728)] == frozenset({"walls_doors_01_13"})


def test_parse_keeps_a_comma_inside_a_tile_name():
    assert parse("1,2,odd,name") == {(1, 2): frozenset({"odd,name"})}


def test_parse_ignores_blank_lines():
    assert parse("\n\n1,2,a\n\n") == {(1, 2): frozenset({"a"})}


def test_parse_rejects_a_malformed_line():
    with pytest.raises(ValueError):
        parse("1,2\n")


def test_suppressed_names_that_square_only():
    mapping = parse("10496,9728,walls_doors_01_12\n")
    assert suppressed(10496, 9728, mapping) == frozenset({"walls_doors_01_12"})
    # The neighbour keeps its vanilla door; skipping it would take its floor
    # and wall with it.
    assert suppressed(10497, 9728, mapping) == frozenset()


def test_empty_map_suppresses_nothing():
    assert suppressed(10496, 9728, {}) == frozenset()
