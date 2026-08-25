import struct

from rcon_save import packet


def test_exec_packet_length_prefix():
    raw = packet(2, 2, "save")
    (length,) = struct.unpack_from("<i", raw)
    assert length == len(raw) - 4
    req_id, kind = struct.unpack_from("<ii", raw, 4)
    assert (req_id, kind) == (2, 2)
    assert raw.endswith(b"save\x00\x00")
