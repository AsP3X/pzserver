"""Sidecar progress for the map's job bubble.

Writes `/pack/job_progress.json` so web-api can read it off the same volume
as `tiles.sqlite`. Stages are coarse; during `render` we scrape pzmap2dzi's
`job: N/M` line.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

JOB_RE = re.compile(r"job:\s*(\d+)\s*/\s*(\d+)")


def write(path: Path, stage: str, percent: float) -> None:
    percent_i = max(0, min(100, int(round(percent))))
    payload = {"stage": stage, "percent": percent_i}
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    os.chmod(tmp, 0o664)
    tmp.replace(path)
    try:
        os.chmod(path, 0o664)
    except OSError:
        pass


def parse_job_line(text: str) -> tuple[int, int] | None:
    last = None
    for match in JOB_RE.finditer(text):
        last = (int(match.group(1)), int(match.group(2)))
    return last


def percent_from_log(text: str, base: float, span: float) -> float:
    parsed = parse_job_line(text)
    if not parsed:
        return base
    done, total = parsed
    if total <= 0:
        return base
    return base + span * min(1.0, done / total)


def watch(path: Path, log: Path, stage: str, base: float, span: float) -> None:
    while True:
        text = ""
        if log.is_file():
            data = log.read_bytes()
            text = data[-12_000:].decode("utf-8", errors="ignore")
        write(path, stage, percent_from_log(text, base, span))
        time.sleep(1)


if __name__ == "__main__":
    if len(sys.argv) < 4 or sys.argv[1] not in ("write", "watch"):
        print(
            "usage: progress.py write <file> <stage> <percent>\n"
            "       progress.py watch <file> <log> <stage> <base> <span>",
            file=sys.stderr,
        )
        raise SystemExit(2)
    cmd = sys.argv[1]
    dest = Path(sys.argv[2])
    if cmd == "write":
        write(dest, sys.argv[3], float(sys.argv[4]))
    else:
        if len(sys.argv) != 7:
            print(
                "usage: progress.py watch <file> <log> <stage> <base> <span>",
                file=sys.stderr,
            )
            raise SystemExit(2)
        watch(dest, Path(sys.argv[3]), sys.argv[4], float(sys.argv[5]), float(sys.argv[6]))
