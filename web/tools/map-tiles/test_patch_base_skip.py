from patch_base_skip import OLD, apply


def test_apply_is_idempotent():
    once = apply(OLD)
    assert "from save_skip import covers" in once
    assert apply(once) == once


def test_apply_keeps_cell_lookup():
    out = apply(OLD)
    assert "cx, subx = divmod(sx, dzi.cell_size)" in out
    assert "_save_covers(sx, sy)" in out
