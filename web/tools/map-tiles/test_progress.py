from progress import parse_job_line, percent_from_log, write


def test_parse_takes_the_last_job_line():
    text = "job: 10/100 worker: 1/1\nnoise\njob: 40/100 worker: 2/2\n"
    assert parse_job_line(text) == (40, 100)


def test_percent_scales_inside_the_stage_span():
    # render stage occupies 20–70
    assert percent_from_log("job: 50/100\n", 20, 50) == 45
    assert percent_from_log("", 20, 50) == 20


def test_write_round_trips(tmp_path):
    path = tmp_path / "job_progress.json"
    write(path, "render", 42.4)
    assert path.read_text(encoding="utf-8") == '{"stage": "render", "percent": 42}'
