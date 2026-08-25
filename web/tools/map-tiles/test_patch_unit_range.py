from patch_unit_range import NEW, OLD, apply


def test_apply_compares_source_units_not_cells():
    out = apply("prefix\n" + OLD + "suffix\n")
    assert "ux * self.source_unit_size" not in out
    assert "rx <= ux < rx + rw" in out
    assert NEW.strip() in out


def test_apply_is_idempotent():
    once = apply(OLD)
    assert apply(once) == once
