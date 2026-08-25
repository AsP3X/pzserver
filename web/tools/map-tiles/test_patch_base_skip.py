from patch_base_skip import OLD, apply


def test_apply_is_idempotent():
    once = apply(OLD)
    assert "from save_skip import suppressed" in once
    assert apply(once) == once


def test_apply_filters_tiles_instead_of_skipping_the_square():
    out = apply(OLD)
    # The loop still runs: the floor and the wall on an open-door square have
    # to keep painting, or nothing puts them back.
    assert "for t in tiles:" in out
    assert "if t in _drop:" in out
    assert "continue" in out
    assert "return" not in out


def test_apply_still_renders_the_tiles_it_keeps():
    assert "tex = self.tl.get_by_name(t)" in apply(OLD)
