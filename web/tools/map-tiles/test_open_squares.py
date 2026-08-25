from open_squares import _sprite_key, write_squares


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
