from pathlib import Path

from chunks import (
    cell_in_rects,
    cell_mtimes,
    chunk_cell,
    chunks_for_cells,
    iter_chunks,
    occupied_cells,
    parse_cell_rects,
    sanitize_save_name,
)


def test_b42_block_to_cell():
    # map/1375/1251.bin — 8-square blocks. 1375*8 = 11000 → cell 42.
    assert chunk_cell(1375, 1251, 8) == (42, 39)


def test_legacy_cell_file_stays_a_cell():
    assert chunk_cell(34, 30, 256) == (34, 30)


def test_sanitize_matches_pzmap2dzi():
    assert sanitize_save_name("Multiplayer/ZomboidServer") == "Multiplayer_ZomboidServer"


def test_iter_chunks_b42_layout(tmp_path):
    blob = tmp_path / "map" / "1375" / "1251.bin"
    blob.parent.mkdir(parents=True)
    blob.write_bytes(b"x")
    (tmp_path / "map_meta.bin").write_bytes(b"no")

    found = list(iter_chunks(tmp_path))
    assert found == [(1375, 1251, 8, blob)]
    assert dict(cell_mtimes(tmp_path))[(42, 39)] >= 0
    assert occupied_cells(tmp_path) == [(42, 39)]


def test_iter_chunks_legacy_map_xy(tmp_path):
    blob = tmp_path / "map_34_30.bin"
    blob.write_bytes(b"x")
    (tmp_path / "map_meta.bin").write_bytes(b"skip")

    found = list(iter_chunks(tmp_path))
    assert found == [(34, 30, 256, blob)]


def test_chunks_for_cells_filters(tmp_path):
    keep = tmp_path / "map" / "1375" / "1251.bin"
    drop = tmp_path / "map" / "1000" / "1000.bin"
    keep.parent.mkdir(parents=True)
    drop.parent.mkdir(parents=True)
    keep.write_bytes(b"k")
    drop.write_bytes(b"d")

    rects = parse_cell_rects("42,39,1,1")
    assert list(chunks_for_cells(tmp_path, rects)) == [keep]
    assert cell_in_rects(42, 39, rects)
    assert not cell_in_rects(31, 31, rects)
