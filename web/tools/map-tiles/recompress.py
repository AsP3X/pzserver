"""Re-encode packed JPEGs at a lower quality, in place.

The original pack was saved at quality 85. Map tiles tolerate 70 with little
visible change and drop a large fraction of the 24 GB. WAL so a live reader
can keep going. Does not VACUUM: free pages stay in the file for later z21
rows to reuse, and VACUUM would rewrite the whole 24 GB beside itself.
"""
import io
import sqlite3
import sys
from pathlib import Path

from PIL import Image


def recompress(db_path: Path, quality: int = 70) -> tuple[int, int, int]:
    """Returns (updated, skipped, bytes_saved)."""
    con = sqlite3.connect(db_path)
    mode = con.execute("PRAGMA journal_mode=WAL").fetchone()[0]
    if str(mode).lower() != "wal":
        con.close()
        raise RuntimeError(f"failed to enable WAL journal_mode (got {mode!r})")

    updated = skipped = saved = 0
    rows = list(con.execute("SELECT z, x, y, data FROM tiles"))
    for z, x, y, data in rows:
        try:
            image = Image.open(io.BytesIO(data))
            image.load()
        except Exception:
            skipped += 1
            continue
        rgb = image.convert("RGB")
        buf = io.BytesIO()
        rgb.save(buf, format="JPEG", quality=quality, optimize=True)
        new = buf.getvalue()
        if len(new) >= len(data):
            skipped += 1
            continue
        saved += len(data) - len(new)
        con.execute(
            "UPDATE tiles SET data = ? WHERE z = ? AND x = ? AND y = ?",
            (new, z, x, y),
        )
        updated += 1
        if updated % 500 == 0:
            con.commit()
            print(f"recompress: {updated} updated, {saved} bytes saved", flush=True)

    con.commit()
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    con.close()
    return updated, skipped, saved


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        print("usage: recompress.py <tiles.sqlite> [quality]", file=sys.stderr)
        raise SystemExit(2)
    path = Path(sys.argv[1])
    quality = int(sys.argv[2]) if len(sys.argv) == 3 else 70
    updated, skipped, saved = recompress(path, quality)
    print(
        f"recompress done: {updated} tiles, {skipped} skipped, "
        f"{saved / 1e9:.2f} GB smaller in-row (file size unchanged until VACUUM)"
    )
