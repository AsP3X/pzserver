"""Which lotpack tile names are the door/window leaf, not the frame.

B42 save chunks store sprite *ids* that do not match `load_tile_defs`
(`fixtures_doors_01_0` is 11264 in the save, 122000 in newtiledefinitions).
The lotpack stores names. When a door opens we skip the named leaf on that
square and leave the floor, wall and frame alone.
"""


def is_door_leaf(name: str) -> bool:
    """The swinging door, not its frame. `indoor` contains `door` — ignore it."""
    lower = name.lower()
    if not lower.startswith("fixtures_doors_"):
        return False
    return "frame" not in lower


def is_window_leaf(name: str) -> bool:
    """The window (or its curtain), not the detailing overlay."""
    lower = name.lower()
    if not lower.startswith("fixtures_windows_"):
        return False
    return "detailing" not in lower


def is_curtain(name: str) -> bool:
    return "curtain" in name.lower()


def is_tree_leaf(name: str) -> bool:
    """The tree (or jumbo canopy), not ground cover around it."""
    lower = name.lower()
    if lower.startswith("vegetation_trees_"):
        return True
    if lower.startswith("jumbo_tree_"):
        return True
    # e_americanhollyJUMBO, e_redmapleJUMBOXL, e_birchJUMBO, …
    if lower.startswith("e_") and ("jumbo" in lower or "tree" in lower):
        return True
    return "stump" in lower


def is_wall_leaf(name: str) -> bool:
    """The wall face, not an overlay/detailing stamp."""
    lower = name.lower()
    if not lower.startswith("walls_"):
        return False
    return "overlay" not in lower and "detailing" not in lower


def is_thumpable_leaf(name: str) -> bool:
    """Player-built carpentry / constructed objects, not vanilla walls."""
    lower = name.lower()
    return (
        lower.startswith("constructedobjects_")
        or lower.startswith("carpentry_")
        or lower.startswith("crafted_")
    )


def is_stump(name: str) -> bool:
    return "stump" in name.lower()


def leaves_for(kind: str, tiles: list[str]) -> list[str]:
    """`kind` is door, window, curtain, tree, wall or thumpable."""
    match = {
        "curtain": is_curtain,
        "window": is_window_leaf,
        "tree": is_tree_leaf,
        "wall": is_wall_leaf,
        "thumpable": is_thumpable_leaf,
    }.get(kind, is_door_leaf)
    return [name for name in tiles if match(name)]
