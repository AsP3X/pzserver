from types import SimpleNamespace

from chunk_sprites import overlay_kind, overlay_sprites, visual_sprite_id


def _obj(sprite_id, class_id=None, **sub):
    base = SimpleNamespace(sprite_id=sprite_id)
    subclass = SimpleNamespace(**sub) if sub else None
    wrapper = SimpleNamespace(
        base_object=base, subclass_object=subclass, class_id=class_id
    )
    return SimpleNamespace(object=wrapper)


def test_plain_object_keeps_sprite_id():
    assert visual_sprite_id(_obj(12)) == 12


def test_open_door_uses_open_sprite():
    door = _obj(
        100,
        open=1,
        locked=0,
        open_sprite_id=200,
        closed_sprite_id=100,
        curtain_flags=0,
    )
    assert visual_sprite_id(door) == 200


def test_closed_door_uses_closed_sprite():
    door = _obj(
        100,
        open=0,
        locked=0,
        open_sprite_id=200,
        closed_sprite_id=100,
        curtain_flags=0,
    )
    assert visual_sprite_id(door) == 100


def test_smashed_window_beats_open():
    window = _obj(
        10,
        open=1,
        destroyed=1,
        glass_removed=0,
        open_sprite_id=11,
        closed_sprite_id=10,
        smashed_sprite_id=12,
        glass_removed_sprite_id=13,
    )
    assert visual_sprite_id(window) == 12


def test_glass_removed_window_beats_smashed():
    window = _obj(
        10,
        open=0,
        destroyed=1,
        glass_removed=1,
        open_sprite_id=11,
        closed_sprite_id=10,
        smashed_sprite_id=12,
        glass_removed_sprite_id=13,
    )
    assert visual_sprite_id(window) == 13


def test_open_curtain_uses_other_sprite():
    curtain = _obj(30, open=1, other_sprite_id=31, barricade_strength=0)
    assert visual_sprite_id(curtain) == 31


def test_closed_curtain_keeps_sprite_id():
    curtain = _obj(30, open=0, other_sprite_id=31, barricade_strength=0)
    assert visual_sprite_id(curtain) == 30


def test_open_thumpable_door_uses_open_sprite():
    door = _obj(
        100,
        open=1,
        is_door=True,
        bit_header=1 | 32 | 64 | 512,
        open_sprite_id=200,
        closed_sprite_id=100,
    )
    assert visual_sprite_id(door) == 200


def test_thumpable_open_is_bit_zero_of_header_when_open_field_missing():
    """pzdataspec's IsoThumpable often has bit_header and no decoded `.open`."""
    door = _obj(
        100,
        is_door=True,
        bit_header=1 | 32 | 64 | 512,
        open_sprite_id=200,
        closed_sprite_id=100,
    )
    assert visual_sprite_id(door) == 200


def test_thumpable_closed_header_without_open_field():
    door = _obj(
        100,
        is_door=True,
        bit_header=32 | 64 | 512,
        open_sprite_id=200,
        closed_sprite_id=100,
    )
    assert visual_sprite_id(door) == 100


def test_closed_thumpable_door_uses_closed_sprite():
    door = _obj(
        100,
        open=0,
        is_door=True,
        bit_header=32 | 64 | 512,
        open_sprite_id=200,
        closed_sprite_id=100,
    )
    assert visual_sprite_id(door) == 100


def test_open_door_without_open_sprite_is_omitted():
    """Open sprite is a hole. Painting the closed id would keep it shut."""
    door = _obj(
        100,
        open=1,
        locked=0,
        closed_sprite_id=100,
        curtain_flags=0,
    )
    assert visual_sprite_id(door) is None


def test_open_window_without_open_sprite_is_omitted():
    window = _obj(
        10,
        open=1,
        destroyed=0,
        glass_removed=0,
        closed_sprite_id=10,
    )
    assert visual_sprite_id(window) is None


def test_overlay_omits_floors_and_keeps_open_doors():
    """Save chunks store containers and floors. Painting those ids with
    load_tile_defs (or a 512-wide door sheet) puts window frames on roads."""
    floor = _obj(12, class_id=0)
    door = _obj(
        100,
        class_id=17,
        open=1,
        locked=0,
        open_sprite_id=200,
        closed_sprite_id=100,
        curtain_flags=0,
    )
    assert overlay_kind(floor) is None
    assert overlay_kind(door) == "door"
    assert overlay_sprites([floor, door]) == [200]
