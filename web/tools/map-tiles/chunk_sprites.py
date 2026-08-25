"""Pick the sprite a square actually shows, not the object's default id.

pzdataspec's ChunkData walks every object and records `base.sprite_id`. For
floors and furniture that is the tile. For IsoDoor / IsoWindow / IsoCurtain
the live picture is a different id: open, closed, smashed, glass-removed,
chosen by flags on the subclass. Vanilla lotpack always paints the closed
sprite, so compositing the same id on top of it is a no-op — doors and
windows never move.

This replaces ChunkData.__init__ after pzdataspec loads, so a pzmap2dzi bump
does not silently drop the fix: patch_save_render.py fails the image build if
init_worker moved.
"""


def visual_sprite_id(obj):
    """Sprite id the isometric overlay should paint for one grid object."""
    wrapper = getattr(obj, "object", obj)
    base = getattr(wrapper, "base_object", None)
    default = getattr(base, "sprite_id", None) if base is not None else None
    sub = getattr(wrapper, "subclass_object", None)
    if sub is None:
        return default

    # Window: smashed / glass-removed / open / closed, in that priority.
    if hasattr(sub, "destroyed") and hasattr(sub, "glass_removed"):
        if getattr(sub, "glass_removed", 0):
            sid = getattr(sub, "glass_removed_sprite_id", None)
            if _usable(sid):
                return sid
        if getattr(sub, "destroyed", 0):
            sid = getattr(sub, "smashed_sprite_id", None)
            if _usable(sid):
                return sid
        if getattr(sub, "open", 0):
            sid = getattr(sub, "open_sprite_id", None)
            if _usable(sid):
                return sid
        sid = getattr(sub, "closed_sprite_id", None)
        if _usable(sid):
            return sid
        return default

    # Door: open vs closed. curtain_flags marks IsoDoor, not IsoWindow.
    if hasattr(sub, "open_sprite_id") and hasattr(sub, "closed_sprite_id") and hasattr(
        sub, "curtain_flags"
    ):
        if getattr(sub, "open", 0):
            if _usable(sub.open_sprite_id):
                return sub.open_sprite_id
        if _usable(sub.closed_sprite_id):
            return sub.closed_sprite_id
        return default

    # Curtain: sprite_id is one state, other_sprite_id the other. `open`
    # selects the alternate.
    if hasattr(sub, "other_sprite_id") and hasattr(sub, "barricade_strength"):
        if getattr(sub, "open", 0) and _usable(sub.other_sprite_id):
            return sub.other_sprite_id
        return default

    return default


def _usable(sid) -> bool:
    return isinstance(sid, int) and sid >= 0


def chunk_data_init(self, raw):
    """Same walk as pzdataspec.utils.ChunkData.__init__, visual sprites."""
    self.raw = raw
    self.block_size = raw.block_size
    mask = 0
    for square in raw.squares:
        mask |= square.layer_flags
    self.init_by_mask(mask)
    for idx, square in enumerate(raw.squares):
        x, y = divmod(idx, self.block_size)
        layer = self.min_layer
        bit = self.min_layer_bit
        for grid_square in square.squares:
            while layer < self.max_layer and (square.layer_flags & bit) == 0:
                bit <<= 1
                layer += 1

            sprites = []
            for obj in grid_square.objects:
                sid = visual_sprite_id(obj)
                if isinstance(sid, int):
                    sprites.append(sid)

            if sprites:
                self._set_sprites(layer, x, y, sprites)
            bit <<= 1
            layer += 1


def patch_chunk_data(utils) -> None:
    """Install visual_sprite_id into a loaded pzdataspec.utils module."""
    utils.ChunkData.__init__ = chunk_data_init
