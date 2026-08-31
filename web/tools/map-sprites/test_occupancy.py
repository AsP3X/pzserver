from occupancy import decode, encode


def test_round_trip_records():
    rows = [(1, 2, 0, 9), (3, 4, 7, 11), (0, 0, -1, 1)]
    assert decode(encode(rows)) == rows


def test_rejects_bad_magic():
    blob = encode([(0, 0, 0, 1)])
    try:
        decode(b"XXXX" + blob[4:])
    except ValueError as error:
        assert "magic" in str(error)
    else:
        raise AssertionError("expected ValueError")
