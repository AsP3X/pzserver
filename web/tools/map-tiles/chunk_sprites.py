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
    """Sprite id the isometric overlay should paint for one grid object.

    Returns None to omit the object: an open door with no open sprite is a
    hole, and painting the closed id would hide that.
    """
    wrapper = getattr(obj, "object", obj)
    base = getattr(wrapper, "base_object", None)
    default = getattr(base, "sprite_id", None) if base is not None else None
    sub = getattr(wrapper, "subclass_object", None)
    if sub is None:
        return default

    # Window: smashed / glass-removed / open / closed, in that priority.
    # open_sprite_id is optional on the B42 ksy (has_open_sprite flag).
    if hasattr(sub, "destroyed") and hasattr(sub, "glass_removed"):
        if _flag(getattr(sub, "glass_removed", 0)):
            sid = getattr(sub, "glass_removed_sprite_id", None)
            if _usable(sid):
                return sid
        if _flag(getattr(sub, "destroyed", 0)):
            sid = getattr(sub, "smashed_sprite_id", None)
            if _usable(sid):
                return sid
        if _flag(getattr(sub, "open", 0)):
            sid = getattr(sub, "open_sprite_id", None)
            if _usable(sid):
                return sid
            return None
        sid = getattr(sub, "closed_sprite_id", None)
        if _usable(sid):
            return sid
        return default

    # Vanilla IsoDoor (class 17). IsoObject.sprite_id stays the closed tile;
    # open/closed ids and the `open` flag are extra fields after super.save.
    # PZwiki: the open tile is tilesheet +2 and is not flagged Door — it is
    # mostly a hole, so we must not fall back to the closed id.
    if hasattr(sub, "curtain_flags") and (
        hasattr(sub, "open_sprite_id") or hasattr(sub, "closed_sprite_id")
    ):
        if _is_open(sub):
            sid = getattr(sub, "open_sprite_id", None)
            if _usable(sid):
                return sid
            return None
        sid = getattr(sub, "closed_sprite_id", None)
        if _usable(sid):
            return sid
        return default

    # Player-built door/window: IsoThumpable (class 18). `open` is bit 0 of
    # bit_header; sprite ids are only present when their bits were written.
    # pzdataspec often exposes only bit_header, not a decoded `.open`.
    if hasattr(sub, "is_door") or hasattr(sub, "bit_header"):
        if _is_open(sub):
            sid = getattr(sub, "open_sprite_id", None)
            if _usable(sid):
                return sid
            return None
        sid = getattr(sub, "closed_sprite_id", None)
        if _usable(sid):
            return sid
        return default

    # Curtain: sprite_id is one state, other_sprite_id the other. `open`
    # selects the alternate.
    if hasattr(sub, "other_sprite_id") and hasattr(sub, "barricade_strength"):
        if _is_open(sub) and _usable(sub.other_sprite_id):
            return sub.other_sprite_id
        return default

    return default


def _header_int(value):
    if hasattr(value, "value") and not isinstance(value, (int, float, bool, str, bytes)):
        value = value.value
    return value if isinstance(value, int) else None


def _is_open(sub) -> bool:
    """IsoDoor writes `open`; IsoThumpable packs it as bit 0 of `bit_header`.

    Prefer the header when both exist: pzdataspec often leaves `.open` at 0
    on class 18 even when the door is open.
    """
    header = _header_int(getattr(sub, "bit_header", None))
    if header is not None:
        return (header & 1) != 0
    if hasattr(sub, "open"):
        return _flag(sub.open)
    return False


def _flag(value) -> bool:
    if hasattr(value, "value") and not isinstance(value, (int, float, bool, str, bytes)):
        value = value.value
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    return bool(value)


def _usable(sid) -> bool:
    if hasattr(sid, "value") and not isinstance(sid, (int, float)):
        sid = sid.value
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
