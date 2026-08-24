from pathlib import Path

from snapshot_save import snapshot


def test_copies_dictionary_and_only_those_cells(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    keep = src / "map" / "1375" / "1251.bin"
    other = src / "map" / "1000" / "1000.bin"
    keep.parent.mkdir(parents=True)
    other.parent.mkdir(parents=True)
    keep.write_bytes(b"keep")
    other.write_bytes(b"other")
    (src / "WorldDictionary.bin").write_bytes(b"dict")

    n = snapshot(src, dst, [(42, 39, 1, 1)])

    assert n == 2
    assert (dst / "WorldDictionary.bin").read_bytes() == b"dict"
    assert (dst / "map" / "1375" / "1251.bin").read_bytes() == b"keep"
    assert not (dst / "map" / "1000" / "1000.bin").exists()
