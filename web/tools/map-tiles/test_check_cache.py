import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent


def run(text, tmp_path, limit="16384"):
    log = tmp_path / "render.log"
    log.write_text(text, encoding="utf-8")
    return subprocess.run([sys.executable, str(HERE / "check_cache.py"), str(log), limit],
                          capture_output=True, text=True, cwd=HERE)


def test_cache_well_under_its_limit_passes(tmp_path):
    """Nothing evicted, so nothing was destroyed. Misses are fine on their own:
    merge_tile falls back to reading the tile from disk."""
    r = run("cache max used: 5760.00 MB\ncache hit: 336482/349463 = 96.29%\n", tmp_path)
    assert r.returncode == 0, r.stderr


def test_cache_reaching_its_limit_fails(tmp_path):
    """Hitting the ceiling means eviction ran. Levels the render omits are
    never written to disk, so evicting one destroys it and its parent merges a
    black quadrant. Measured: limit 4096, max used 4112, ~13,000 holes."""
    r = run("cache max used: 4112.00 MB\ncache hit: 336376/349463 = 96.26%\n", tmp_path, limit="4096")
    assert r.returncode != 0
    assert "4112" in r.stdout + r.stderr
    assert "cache_limit_mb" in r.stdout + r.stderr


def test_close_to_the_limit_also_fails(tmp_path):
    """Within 5% is not a pass. The peak is sampled, so a run that grazed the
    ceiling between samples looks identical to one that sat on it."""
    r = run("cache max used: 15800.00 MB\n", tmp_path)
    assert r.returncode != 0


def test_a_missing_report_fails_rather_than_passing_silently(tmp_path):
    r = run("rendering\nDone\n", tmp_path)
    assert r.returncode != 0
