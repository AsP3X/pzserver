"""Rewrite map_info.json w/h/skip to match a different omit_levels.

pzmap2dzi refuses to render when on-disk skip (from the full omit_levels: 2
pack) does not match the conf. A z21 fill patches omit_levels to 1 for the
run; this keeps x0/y0/sqr/cell_rects and rescales w/h.
"""
import json
import sys
from pathlib import Path


def align(info: dict, skip: int) -> dict:
    old = int(info.get("skip", 0))
    if old == skip:
        return info
    full_w = info["w"] * (2**old)
    full_h = info["h"] * (2**old)
    out = dict(info)
    out["w"] = full_w // (2**skip)
    out["h"] = full_h // (2**skip)
    out["skip"] = skip
    return out


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: align_map_info_skip.py <map_info.json> <skip>", file=sys.stderr)
        raise SystemExit(2)
    path = Path(sys.argv[1])
    skip = int(sys.argv[2])
    info = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps(align(info, skip), indent=1) + "\n", encoding="utf-8")
    print(f"map_info skip {info.get('skip', 0)} -> {skip}")
