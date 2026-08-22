import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent


def run(conf: Path, cells: str):
    return subprocess.run(
        [sys.executable, str(HERE / "set_render_range.py"), str(conf), cells],
        capture_output=True, text=True, cwd=HERE,
    )


def test_inserts_the_key_when_the_config_has_none(tmp_path):
    """Our conf.yaml overwrites pzmap2dzi's shipped one and never had this
    key, so replacing-only silently fails the whole run."""
    conf = tmp_path / "conf.yaml"
    conf.write_text("render_conf:\n    verbose: true\n    tile_size: 2048\n", encoding="utf-8")

    r = run(conf, "39,36")

    assert r.returncode == 0, r.stderr
    text = conf.read_text(encoding="utf-8")
    assert "render_cell_range:" in text
    assert "- [39, 36, 1, 1]" in text
    # must land inside render_conf, indented under it
    body = text.split("render_conf:")[1]
    assert "    render_cell_range:" in body


def test_replaces_an_existing_key(tmp_path):
    conf = tmp_path / "conf.yaml"
    conf.write_text("render_conf:\n    render_cell_range: all\n    tile_size: 2048\n", encoding="utf-8")

    r = run(conf, "34,30,4,4")

    assert r.returncode == 0, r.stderr
    text = conf.read_text(encoding="utf-8")
    assert "all" not in text.split("render_cell_range:")[1].split("\n")[0]
    assert "- [34, 30, 4, 4]" in text
    assert "tile_size: 2048" in text


def test_leaves_dzi_cell_range_alone(tmp_path):
    """dzi_cell_range fixes the pyramid's bounds. Touching it moves every pin."""
    conf = tmp_path / "conf.yaml"
    conf.write_text(
        "render_conf:\n    dzi_cell_range: auto\n    render_cell_range: all\n", encoding="utf-8")

    run(conf, "39,36")

    assert "dzi_cell_range: auto" in conf.read_text(encoding="utf-8")


def test_set_omit_levels_rewrites_the_number(tmp_path):
    conf = tmp_path / "conf.yaml"
    conf.write_text("render_conf:\n    omit_levels: 2\n    tile_size: 2048\n", encoding="utf-8")

    r = subprocess.run(
        [sys.executable, str(HERE / "set_omit_levels.py"), str(conf), "1"],
        capture_output=True, text=True, cwd=HERE,
    )

    assert r.returncode == 0, r.stderr
    assert "omit_levels: 1" in conf.read_text(encoding="utf-8")
    assert "tile_size: 2048" in conf.read_text(encoding="utf-8")


def test_multiple_rects(tmp_path):
    conf = tmp_path / "conf.yaml"
    conf.write_text("render_conf:\n    tile_size: 2048\n", encoding="utf-8")

    run(conf, "34,30;40,12,2,2")

    text = conf.read_text(encoding="utf-8")
    assert "- [34, 30, 1, 1]" in text
    assert "- [40, 12, 2, 2]" in text
