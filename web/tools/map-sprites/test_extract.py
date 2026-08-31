from extract import (
    _records_from_blocks,
    _records_from_squares,
    cell_records,
    iter_named_rows,
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
