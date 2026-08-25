from patch_merge_filter import OLD, apply


def test_apply_is_idempotent():
    once = apply(OLD)
    assert apply(once) == once


def test_merge_uses_box_not_lanczos():
    out = apply(OLD)
    assert "Image.BOX" in out
    assert "Image.LANCZOS" not in out


def test_apply_refuses_an_unfamiliar_merge():
    try:
        apply("def merge_tile(self):\n    return None\n")
    except SystemExit:
        return
    raise AssertionError("expected SystemExit")
