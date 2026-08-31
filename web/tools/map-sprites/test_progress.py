from progress import Bar, _clip, _eta


def test_eta_formats():
    assert _eta(None) == "--"
    assert _eta(65) == "1m05s"
    assert _eta(3661).startswith("1h")


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
