"""Packed occupancy for one 256×256 cell.

Layout (little-endian):
  magic   4 bytes  SPR1
  count   u32
  records count × { lx:u8, ly:u8, z:i8, sprite_id:u32 }
"""

from __future__ import annotations

import struct
from collections.abc import Iterable

MAGIC = b"SPR1"
RECORD = struct.Struct("<BBbI")
HEADER = struct.Struct("<4sI")


def encode(records: Iterable[tuple[int, int, int, int]]) -> bytes:
    rows = list(records)
    out = bytearray(HEADER.size + RECORD.size * len(rows))
    HEADER.pack_into(out, 0, MAGIC, len(rows))
    offset = HEADER.size
    for lx, ly, z, sprite_id in rows:
        RECORD.pack_into(out, offset, lx, ly, z, sprite_id)
        offset += RECORD.size
    return bytes(out)


def decode(blob: bytes) -> list[tuple[int, int, int, int]]:
    if len(blob) < HEADER.size:
        raise ValueError("occupancy blob too short")
    magic, count = HEADER.unpack_from(blob, 0)
    if magic != MAGIC:
        raise ValueError(f"bad occupancy magic {magic!r}")
    need = HEADER.size + RECORD.size * count
    if len(blob) < need:
        raise ValueError("occupancy blob truncated")
    rows = []
    offset = HEADER.size
    for _ in range(count):
        rows.append(RECORD.unpack_from(blob, offset))
        offset += RECORD.size
    return rows
