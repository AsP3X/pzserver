"""B42 (and leftover B41) save chunk files → map cells.

Dedicated-server worlds we run are B42: `Saves/Multiplayer/<name>/map/{x}/{y}.bin`
where x, y are 8-square blocks. A cell is 256 squares, so 32×32 blocks.

Older worlds keep `map_{cx}_{cy}.bin` named by cell. Both layouts are scanned
so a detector and a snapshot copy the same files pzmap2dzi's save render reads.
"""
from pathlib import Path

CELL_SIZE = 256
B42_BLOCK = 8


def sanitize_save_name(save_game: str) -> str:
    """Match pzmap2dzi main.py: save output lives under this folder name."""
    import re

    return re.sub(r"(?u)[^-.\w]", "_", save_game)


def iter_chunks(save: Path):
    """Yield `(block_or_cell_x, y, unit_squares, path)` for every map bin.

    `unit_squares` is 8 for B42 blocks and 256 when the file is already a cell.
    """
    save = Path(save)
    map_dir = save / "map"
    if map_dir.is_dir():
        for xdir in sorted(map_dir.iterdir()):
            if not xdir.is_dir() or not xdir.name.isdigit():
                continue
            x = int(xdir.name)
            for blob in sorted(xdir.glob("*.bin")):
                if not blob.stem.isdigit():
                    continue
                yield x, int(blob.stem), B42_BLOCK, blob
        return

    for blob in sorted(save.glob("map_*_*.bin")):
        parts = blob.stem.split("_")
        if len(parts) != 3 or not parts[1].isdigit() or not parts[2].isdigit():
            continue
        yield int(parts[1]), int(parts[2]), CELL_SIZE, blob


def chunk_cell(x: int, y: int, unit: int) -> tuple[int, int]:
    """Which 256-square cell a chunk file belongs to."""
    return (x * unit) // CELL_SIZE, (y * unit) // CELL_SIZE


def cell_mtimes(save: Path) -> dict[tuple[int, int], int]:
    """Max mtime (unix seconds) of every chunk in each cell."""
    out: dict[tuple[int, int], int] = {}
    for x, y, unit, path in iter_chunks(save):
        cell = chunk_cell(x, y, unit)
        mtime = int(path.stat().st_mtime)
        prev = out.get(cell)
        if prev is None or mtime > prev:
            out[cell] = mtime
    return out


def parse_cell_rects(text: str) -> list[tuple[int, int, int, int]]:
    """`x,y,w,h` semicolon list, same grammar as render_cells.txt."""
    rects = []
    for chunk in text.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = [int(p) for p in chunk.split(",")]
        if len(parts) == 2:
            rects.append((parts[0], parts[1], 1, 1))
        elif len(parts) == 4:
            rects.append((parts[0], parts[1], parts[2], parts[3]))
        else:
            raise ValueError(f"cell rect must be x,y or x,y,w,h -- got {chunk!r}")
    return rects


def cell_in_rects(cx: int, cy: int, rects) -> bool:
    for x, y, w, h in rects:
        if x <= cx < x + w and y <= cy < y + h:
            return True
    return False


def chunks_for_cells(save: Path, rects):
    """Chunk files whose cell sits inside any of the rects."""
    for x, y, unit, path in iter_chunks(save):
        cx, cy = chunk_cell(x, y, unit)
        if cell_in_rects(cx, cy, rects):
            yield path
