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
import time

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
    sock = connect(host, port, timeout)
    try:
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
    finally:
        sock.close()


def connect(host: str, port: int, timeout: float) -> socket.socket:
    """Prefer IPv4: the game image disables IPv6, and AAAA can refuse."""
    errors = []
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            infos = socket.getaddrinfo(host, port, family, socket.SOCK_STREAM)
        except socket.gaierror as error:
            errors.append(str(error))
            continue
        for family, socktype, proto, _, sockaddr in infos:
            sock = socket.socket(family, socktype, proto)
            sock.settimeout(timeout)
            try:
                sock.connect(sockaddr)
                return sock
            except OSError as error:
                errors.append(f"{sockaddr}: {error}")
                sock.close()
    raise RuntimeError("; ".join(errors) or f"could not connect to {host}:{port}")


def hosts_to_try(primary: str) -> list[str]:
    hosts = []
    for name in (primary, "game-server", "pz-game-server"):
        if name and name not in hosts:
            hosts.append(name)
    return hosts


def save_with_retry(
    hosts: list[str],
    port: int,
    password: str,
    timeout: float = 8.0,
    wait_secs: float = 120.0,
    interval: float = 3.0,
) -> str:
    deadline = time.time() + wait_secs
    last_error = "RCON did not respond"
    attempted = False
    while True:
        for host in hosts:
            try:
                return save(host, port, password, timeout=timeout)
            except Exception as error:
                last_error = f"{host}:{port}: {error}"
                attempted = True
        if time.time() >= deadline:
            break
        if not attempted:
            break
        print(f"waiting for RCON ({last_error})", flush=True)
        time.sleep(interval)
    raise RuntimeError(last_error)


if __name__ == "__main__":
    host = os.environ.get("PZ_RCON_HOST", "game-server")
    port = int(os.environ.get("PZ_RCON_PORT", "27015"))
    password = os.environ.get("PZ_RCON_PASSWORD", "")
    wait_secs = float(os.environ.get("PZ_RCON_WAIT_SECS", "180"))
    try:
        reply = save_with_retry(hosts_to_try(host), port, password, wait_secs=wait_secs)
    except Exception as error:
        print(f"RCON save skipped: {error}", file=sys.stderr)
        print(
            "Is game-server finished loading? RCON only listens after PZ is up "
            "(docker compose ps / healthcheck). Connection refused right after "
            "./deploy.sh is expected until the world is loaded.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    print(f"RCON save: {reply.strip() or 'ok'}")
