from progress import Bar, _clip, _eta, _smooth_eta


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def add(self, seconds: float) -> None:
        self.t += seconds


def test_eta_formats():
    assert _eta(None) == "--"
    assert _eta(65) == "1m05s"
    assert _eta(3661).startswith("1h")
    assert _eta(90000).startswith("1d")


def test_smooth_eta_hides_jitter():
    assert _smooth_eta(None) is None
    assert _smooth_eta(12) == 12
    assert _smooth_eta(94) == 90


def test_clip_fits_width():
    assert len(_clip("abcdefghij", 4)) == 4
    assert _clip("ab", 8) == "ab"


def test_bar_reaches_total(capsys):
    bar = Bar("scan", 4)
    bar.tick()
    bar.tick()
    bar.finish()
    assert bar.done == 4
    captured = capsys.readouterr()
    assert "scan" in captured.err
    assert "100.0%" in captured.err


def test_eta_hidden_until_warmup():
    clock = Clock()
    bar = Bar("scan", 100, clock=clock)
    clock.add(0.5)
    bar.tick()
    assert bar.eta_seconds() is None


def test_eta_tracks_steady_rate():
    clock = Clock()
    bar = Bar("scan", 100, clock=clock)
    for _ in range(20):
        clock.add(1.0)
        bar.tick()
    eta = bar.eta_seconds()
    assert eta is not None
    assert 70 < eta < 90


def test_eta_uses_this_session_after_resume():
    clock = Clock()
    bar = Bar("scan", 100, done=50, work_done=50, work_total=100, clock=clock)
    for _ in range(5):
        clock.add(1.0)
        bar.tick()
    eta = bar.eta_seconds()
    assert eta is not None
    assert 40 < eta < 50
