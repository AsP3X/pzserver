import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent


def run(conf: Path, root: str, save: str):
    return subprocess.run(
        [sys.executable, str(HERE / "set_save_game.py"), str(conf), root, save],
        capture_output=True,
        text=True,
        cwd=HERE,
    )


def test_rewrites_root_and_list(tmp_path):
    conf = tmp_path / "conf.yaml"
    conf.write_text(
        "save_game_root: /dev/null\nsave_games: []\nrender_conf:\n    verbose: true\n",
        encoding="utf-8",
    )

    r = run(conf, "/out/save-snapshot", "Multiplayer/ZomboidServer")
    assert r.returncode == 0, r.stderr
    text = conf.read_text(encoding="utf-8")
    assert "save_game_root: /out/save-snapshot" in text
    assert "- Multiplayer/ZomboidServer" in text
    assert "/dev/null" not in text
    assert "save_games: []" not in text
    assert "verbose: true" in text
