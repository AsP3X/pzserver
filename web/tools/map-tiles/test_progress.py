from progress import extra_from_env, parse_env_rects, parse_job_line, percent_from_log, write


def test_parse_takes_the_last_job_line():
    text = "job: 10/100 worker: 1/1\nnoise\njob: 40/100 worker: 2/2\n"
    assert parse_job_line(text) == (40, 100)


def test_percent_scales_inside_the_stage_span():
    # render stage occupies 20–70
    assert percent_from_log("job: 50/100\n", 20, 50) == 45
    assert percent_from_log("", 20, 50) == 20


def test_write_round_trips(tmp_path):
    import json

    path = tmp_path / "job_progress.json"
    write(path, "render", 42.4)
    body = json.loads(path.read_text(encoding="utf-8"))
    assert body["stage"] == "render"
    assert body["percent"] == 42


def test_env_rects_expand_two_numbers():
    assert parse_env_rects("41,38") == [[41, 38, 1, 1]]
    assert parse_env_rects("41,38,1,1;40,12") == [[41, 38, 1, 1], [40, 12, 1, 1]]


def test_write_includes_cells_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("PZ_MAP_CELLS", "41,38")
    path = tmp_path / "job_progress.json"
    write(path, "plan", 6)
    body = path.read_text(encoding="utf-8")
    assert '"cells": [[41, 38, 1, 1]]' in body
    assert extra_from_env()["cells"] == [[41, 38, 1, 1]]
