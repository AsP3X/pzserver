"""Ask the dedicated server to flush chunks before we snapshot them.

Opening a door updates Java memory. The `map/{x}/{y}.bin` file often still
has the closed sprite until `save` runs. Snapshotting without that flush is
why a rerender paints the door shut.
"""
from __future__ import annotations

import os
import socket
import struct
import sys

AUTH = 3
EXEC = 2
AUTH_FAIL_ID = -1


def packet(req_id: int, kind: int, body: str) -> bytes:
    payload = struct.pack("<ii", req_id, kind) + body.encode("utf-8") + b"\x00\x00"
    return struct.pack("<i", len(payload)) + payload


def read_packet(sock: socket.socket) -> tuple[int, int, str]:
    header = sock.recv(4)
    if len(header) < 4:
        raise RuntimeError("RCON closed")
    (length,) = struct.unpack("<i", header)
    if length < 10 or length > 4112:
        raise RuntimeError(f"bad RCON length {length}")
    payload = b""
    while len(payload) < length:
        chunk = sock.recv(length - len(payload))
        if not chunk:
            raise RuntimeError("RCON closed mid-packet")
        payload += chunk
    req_id, kind = struct.unpack_from("<ii", payload)
    body = payload[8:].split(b"\x00", 1)[0].decode("utf-8", "replace")
    return req_id, kind, body


def save(host: str, port: int, password: str, timeout: float = 8.0) -> str:
    if not password:
        raise RuntimeError("PZ_RCON_PASSWORD is empty")
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(packet(1, AUTH, password))
        first_id, first_kind, _ = read_packet(sock)
        if first_kind == 0:
            first_id, _, _ = read_packet(sock)
        if first_id == AUTH_FAIL_ID:
            raise RuntimeError("RCON authentication was rejected")
        sock.sendall(packet(2, EXEC, "save"))
        _, _, body = read_packet(sock)
        return body


if __name__ == "__main__":
    host = os.environ.get("PZ_RCON_HOST", "game-server")
    port = int(os.environ.get("PZ_RCON_PORT", "27015"))
    password = os.environ.get("PZ_RCON_PASSWORD", "")
    try:
        reply = save(host, port, password)
    except Exception as error:
        print(f"RCON save skipped: {error}", file=sys.stderr)
        raise SystemExit(1)
    print(f"RCON save: {reply.strip() or 'ok'}")
