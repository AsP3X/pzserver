"""Point pzmap2dzi at one dedicated-server world for `render save`."""
import re
import sys
from pathlib import Path

if len(sys.argv) != 4:
    print("usage: set_save_game.py <conf.yaml> <save_game_root> <save_game>", file=sys.stderr)
    raise SystemExit(2)

conf, root, save_game = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
text = conf.read_text(encoding="utf-8")

root_line = f"save_game_root: {root}\n"
patched, n = re.subn(r"^save_game_root:[^\n]*\n", root_line, text, count=1, flags=re.M)
if not n:
    print(f"FAIL: {conf} has no save_game_root key", file=sys.stderr)
    raise SystemExit(1)

games = f"save_games:\n    - {save_game}\n"
patched, n = re.subn(
    r"^save_games:[^\n]*\n(?:[ \t]+-[^\n]*\n)*",
    games,
    patched,
    count=1,
    flags=re.M,
)
if not n:
    print(f"FAIL: {conf} has no save_games key", file=sys.stderr)
    raise SystemExit(1)

conf.write_text(patched, encoding="utf-8")
print(f"save_game_root = {root}")
print(f"save_games = [{save_game}]")
