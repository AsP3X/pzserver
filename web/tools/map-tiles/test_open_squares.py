from open_squares import write_rects


def test_write_rects_is_semicolon_list(tmp_path):
    dest = tmp_path / "skip.txt"
    write_rects(dest, [(10496, 9728, 1, 1), (10497, 9728, 1, 1)])
    assert dest.read_text(encoding="utf-8") == "10496,9728,1,1;10497,9728,1,1"
