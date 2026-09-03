#!/usr/bin/env python3
"""Read or set one KEY=value line in a Project Zomboid server.ini.

PZ ini files are flat. Do not wrap them in an INI section header — that
breaks the dedicated server on the next boot.
"""

from __future__ import annotations

import sys
from pathlib import Path


def usage() -> None:
    print("Usage: edit_server_config.py <file> <key> [value]", file=sys.stderr)
    sys.exit(1)


def main(argv: list[str]) -> int:
    if len(argv) not in (3, 4):
        usage()

    path = Path(argv[1])
    key = argv[2]
    prefix = f"{key}="

    try:
        rows = path.read_text().splitlines(keepends=True)
    except FileNotFoundError:
        print(f"{path} not found", file=sys.stderr)
        return 1

    if len(argv) == 3:
        for row in rows:
            line = row.strip()
            if line.startswith(prefix):
                print(line[len(prefix) :])
                return 0
        return 0

    value = argv[3]
    replacement = f"{key}={value}\n"
    out: list[str] = []
    replaced = False
    for row in rows:
        if row.strip().startswith(prefix):
            out.append(replacement)
            replaced = True
        else:
            out.append(row)
    if not replaced:
        out.append(replacement)
    path.write_text("".join(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
