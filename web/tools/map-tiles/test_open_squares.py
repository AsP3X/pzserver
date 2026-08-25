from types import SimpleNamespace

from open_squares import _kind, _lotpack_stale, _sprite_key, open_squares, write_squares


def test_write_squares_is_one_sprite_per_line(tmp_path):
    dest = tmp_path / "skip.txt"
    write_squares(
        dest,
        [
            (10496, 9728, "walls_doors_01_12"),
            (10496, 9728, "walls_windows_01_4"),
            (10497, 9728, "walls_doors_01_13"),
        ],
    )
    assert dest.read_text(encoding="utf-8") == (
        "10496,9728,walls_doors_01_12\n"
        "10496,9728,walls_windows_01_4\n"
        "10497,9728,walls_doors_01_13\n"
    )


def test_write_squares_of_nothing_is_empty(tmp_path):
    dest = tmp_path / "skip.txt"
    write_squares(dest, [])
    assert dest.read_text(encoding="utf-8") == ""


class _Wrapped:
    """Kaitai hands sprite ids back boxed as often as bare."""

    def __init__(self, value):
        self.value = value


def test_sprite_key_unwraps_kaitai_values():
    assert _sprite_key(17) == 17
    assert _sprite_key(_Wrapped(17)) == 17


def test_sprite_key_rejects_what_is_not_an_id():
    assert _sprite_key(None) is None
    assert _sprite_key(_Wrapped(None)) is None
    assert _sprite_key("17") is None


def _door(open_flag=1, closed=11264, opened=11266):
    sub = SimpleNamespace(
        open=open_flag,
        closed_sprite_id=closed,
        open_sprite_id=opened,
        curtain_flags=0,
    )
    base = SimpleNamespace(sprite_id=closed)
    wrapper = SimpleNamespace(
        class_id=17, base_object=base, subclass_object=sub
    )
    return SimpleNamespace(object=wrapper)


def test_open_door_is_stale_even_when_sprite_id_is_already_the_open_tile():
    """B42 writes the open id as sprite_id. That must still skip the closed leaf."""
    assert _lotpack_stale(_door(open_flag=1, closed=11266, opened=11266))
    assert not _lotpack_stale(_door(open_flag=0, closed=11264, opened=11266))


def test_kind_is_door_window_or_curtain():
    assert _kind(_door()) == "door"
    window = SimpleNamespace(
        object=SimpleNamespace(
            class_id=26,
            base_object=SimpleNamespace(sprite_id=1),
            subclass_object=SimpleNamespace(
                destroyed=0, glass_removed=0, open=0
            ),
        )
    )
    assert _kind(window) == "window"
    curtain = SimpleNamespace(
        object=SimpleNamespace(
            class_id=19,
            base_object=SimpleNamespace(sprite_id=30),
            subclass_object=SimpleNamespace(
                other_sprite_id=31, barricade_strength=0, open=1
            ),
        )
    )
    assert _kind(curtain) == "curtain"


def test_open_squares_skips_the_lotpack_leaf_not_the_id(monkeypatch):
    """Save ids do not match load_tile_defs; the lotpack name is the skip."""
    from open_squares import _lotpack_square as real  # noqa: F401

    def fake_lotpack(map_root, cache, wx, wy):
        return [
            "floors_interior_tilesandwood_01_23",
            "fixtures_doors_frames_01_0",
            "fixtures_doors_01_0",
        ]

    monkeypatch.setattr("open_squares._lotpack_square", fake_lotpack)
    monkeypatch.setattr(
        "open_squares.iter_chunks",
        lambda save: [(0, 0, 8, "unused.bin")],
    )

    import sys
    import types

    utils = types.ModuleType("pzdataspec.utils")

    def load_chunk(path, version=42):
        square = SimpleNamespace(
            squares=[SimpleNamespace(objects=[_door(open_flag=1)])]
        )
        raw = SimpleNamespace(block_size=8, squares=[square])
        return SimpleNamespace(raw=raw)

    utils.load_chunk = load_chunk
    sys.modules["pzdataspec"] = types.ModuleType("pzdataspec")
    sys.modules["pzdataspec.utils"] = utils
    found = open_squares(
        save=__import__("pathlib").Path("."),
        tiledef={11264: "floors_overlay_street_01_0"},
        map_root=__import__("pathlib").Path("/maps"),
    )
    assert found == [(0, 0, "fixtures_doors_01_0")]
