from patch_save_render import NEW, OLD, apply


def test_apply_is_idempotent():
    once = apply(OLD)
    assert "from chunk_sprites import patch_chunk_data" in once
    assert apply(once) == once


def test_apply_keeps_tiledef_load():
    out = apply("prefix\n" + OLD + "suffix\n")
    assert "self.tiledef = self.utils.load_tile_defs" in out
    assert NEW.strip() in out
