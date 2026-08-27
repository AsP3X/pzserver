from patch_save_render import NEW, OLD, apply


def test_apply_is_idempotent():
    once = apply(OLD)
    assert "from chunk_sprites import patch_chunk_data" in once
    assert apply(once) == once


def test_apply_uses_lotpack_map_only():
    """load_tile_defs on B42 chunk ids paints window frames on roads."""
    out = apply("prefix\n" + OLD + "suffix\n")
    assert "self.tiledef = read_map" in out
    assert "self.tiledef = self.utils.load_tile_defs" not in out
    assert "load_tile_defs unused" in out
    assert NEW.strip() in out
