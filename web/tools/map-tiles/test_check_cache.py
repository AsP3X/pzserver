import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent


def run(text, tmp_path):
    log = tmp_path / "render.log"
    log.write_text(text, encoding="utf-8")
    return subprocess.run([sys.executable, str(HERE / "check_cache.py"), str(log)],
                          capture_output=True, text=True, cwd=HERE)


def test_a_full_hit_rate_passes(tmp_path):
    r = run("rendering\ncache hit: 349463/349463 = 100.00%\nDone\n", tmp_path)
    assert r.returncode == 0, r.stderr


def test_any_miss_fails(tmp_path):
    """A miss means a deep tile was evicted before its parent merged it. Those
    levels are never written to disk, so the tile is gone and the parent has a
    black quadrant. This is the exact failure that put holes across the map."""
    r = run("cache hit: 336376/349463 = 96.26%\nDone\n", tmp_path)
    assert r.returncode != 0
    assert "13087" in r.stdout + r.stderr, "should say how many tiles were lost"
    assert "cache_limit_mb" in r.stdout + r.stderr, "should say what to change"


def test_a_missing_line_fails_rather_than_passing_silently(tmp_path):
    """Absence of evidence is not evidence of success -- that assumption is
    what let every previous defect through."""
    r = run("rendering\nDone\n", tmp_path)
    assert r.returncode != 0


def test_it_reads_the_last_report_when_several_are_present(tmp_path):
    r = run("cache hit: 1/2 = 50.00%\ncache hit: 349463/349463 = 100.00%\n", tmp_path)
    assert r.returncode == 0, r.stderr
