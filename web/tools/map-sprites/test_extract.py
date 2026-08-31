from extract import (
    Checkpointer,
    StopFlag,
    _records_from_blocks,
    _records_from_squares,
    cell_records,
    fingerprint,
    iter_named_rows,
    job_coords,
    pack_named_rows,
)


class FakeCell:
    def __init__(self):
        self.header = {"tiles": ["", "grass", "wall"]}
        self.block_size = 2
        self.block_per_cell = 1
        self.cell_size = 2
        self.minlayer = 0
        self.maxlayer = 2
        layer0 = [
            [[1], None],
            [None, [1]],
        ]
        layer1 = [
            [[2], None],
            [None, None],
        ]
        self.blocks = [[layer0, layer1]]

    def get_square(self, subx, suby, layer):
        if layer < self.minlayer or layer >= self.maxlayer:
            return None
        bx, x = divmod(subx, self.block_size)
        by, y = divmod(suby, self.block_size)
        block = self.blocks[bx * self.block_per_cell + by]
        layer_data = block[layer] if 0 <= layer < len(block) else None
        if not layer_data:
            return None
        row = layer_data[x]
        if not row:
            return None
        tiles = row[y]
        if not tiles:
            return None
        return [self.header["tiles"][t] for t in tiles]


def test_block_walk_matches_get_square():
    cell = FakeCell()
    from_blocks = _records_from_blocks(cell)
    from_squares = _records_from_squares(cell)
    assert sorted(from_blocks) == sorted(from_squares)
    assert {name for _x, _y, _z, name in from_blocks} == {"grass", "wall"}
    assert cell_records(cell) == from_blocks


def test_named_rows_round_trip():
    rows = [(1, 2, 0, "grass"), (3, 4, 7, "wall"), (0, 0, -1, "grass")]
    names, blob = pack_named_rows(rows)
    assert names == ["grass", "wall"]
    assert list(iter_named_rows(names, blob)) == rows


def test_job_coords():
    assert job_coords("world_10_-3.lotpack") == (10, -3)
    assert job_coords("readme.txt") is None


def test_fingerprint_changes_with_file_size(tmp_path):
    maps = tmp_path / "maps" / "Muldraugh, KY"
    maps.mkdir(parents=True)
    lot = maps / "world_0_0.lotpack"
    lot.write_bytes(b"abc")
    textures = tmp_path / "packs"
    textures.mkdir()
    (textures / "Tiles.pack").write_bytes(b"pack")
    jobs = [(str(maps), maps.name, lot.name)]
    first = fingerprint(jobs, textures, "42.20.0")
    second = fingerprint(jobs, textures, "42.20.0")
    assert first == second
    lot.write_bytes(b"abcdef")
    assert fingerprint(jobs, textures, "42.20.0") != first


def test_scan_checkpoint_round_trip(tmp_path):
    from store import open_work

    con = open_work(tmp_path / "bake.sqlite")
    check = Checkpointer(con)
    names, blob = pack_named_rows([(1, 2, 0, "grass")])
    check.persist_scan(
        "Muldraugh, KY",
        10,
        20,
        empty=False,
        names=names,
        blob=blob,
        z_min=0,
        z_max=1,
    )
    check.persist_scan("Muldraugh, KY", 11, 20, empty=True)
    check.flush(force=True)
    cells, unique, z_min, z_max, done = check.load_scan()
    assert unique == {"grass"}
    assert list(iter_named_rows(*cells[(10, 20)])) == [(1, 2, 0, "grass")]
    assert ("Muldraugh, KY", 11, 20) in done
    assert ("Muldraugh, KY", 10, 20) in done
    assert (11, 20) not in cells
    assert z_max == 1


def test_stop_flag_first_signal_is_soft():
    import signal

    flag = StopFlag()
    assert flag.stop is False
    flag._on(signal.SIGINT, None)
    assert flag.stop is True
