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


def leaves_for(kind: str, tiles: list[str]) -> list[str]:
    """`kind` is door, window or curtain."""
    if kind == "curtain":
        match = is_curtain
    elif kind == "window":
        match = is_window_leaf
    else:
        match = is_door_leaf
    return [name for name in tiles if match(name)]
