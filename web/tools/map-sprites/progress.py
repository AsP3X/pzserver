"""In-place progress line, same idea as map-tiles/import.sh.

TTY: one rewriting line (CR + erase-tail). Pipe/CI: a full line every few
seconds so logs stay readable.
"""

from __future__ import annotations

import os
import sys
import time


def _tty() -> bool:
    return sys.stderr.isatty() and os.environ.get("TERM", "") != "dumb"


def _cols() -> int:
    raw = os.environ.get("COLUMNS", "")
    if raw.isdigit():
        return max(20, int(raw))
    try:
        return max(20, os.get_terminal_size(2).columns)
    except OSError:
        return 80


def _eta(seconds: float | None) -> str:
    if seconds is None or seconds < 0:
        return "--"
    sec = int(seconds)
    if sec >= 3600:
        return f"{sec // 3600}h{(sec % 3600) // 60:02d}m"
    return f"{sec // 60}m{sec % 60:02d}s"


class Bar:
    def __init__(self, label: str, total: int) -> None:
        self.label = label
        self.total = max(int(total), 1)
        self.done = 0
        self.start = time.monotonic()
        self.tty = _tty()
        self._last_static = 0.0
        self._hidden = False
        if self.tty:
            sys.stderr.write("\033[?25l")
            self._hidden = True

    def tick(self, n: int = 1, extra: str = "") -> None:
        self.done = min(self.total, self.done + n)
        self.paint(extra)

    def paint(self, extra: str = "", force: bool = False) -> None:
        now = time.monotonic()
        if not self.tty and not force and now - self._last_static < 2:
            return
        self._last_static = now
        elapsed = max(now - self.start, 0.001)
        rate = self.done / elapsed
        remain = (self.total - self.done) / rate if rate > 0 and self.done < self.total else 0
        pct = 100.0 * self.done / self.total
        suffix = f"  {pct:5.1f}%  {self.done}/{self.total}  {rate:.1f}/s  eta {_eta(remain)}"
        if extra:
            suffix += f"  {extra}"
        prefix = f"{self.label} "
        cols = _cols()
        bar_w = cols - len(prefix) - len(suffix) - 3
        if bar_w < 8:
            suffix = f"  {pct:5.1f}%  {self.done}/{self.total}"
            bar_w = max(8, cols - len(prefix) - len(suffix) - 3)
        filled = int(bar_w * (self.done / self.total))
        if self.done >= self.total:
            filled = bar_w
        body = "=" * filled + " " * (bar_w - filled)
        if 0 < self.done < self.total and 0 < filled < bar_w:
            body = body[: filled - 1] + ">" + body[filled:]
        line = f"{prefix}[{body}]{suffix}"
        if self.tty:
            sys.stderr.write(f"\r{line}\033[K")
        else:
            sys.stderr.write(line + "\n")
        sys.stderr.flush()

    def finish(self, extra: str = "") -> None:
        self.done = self.total
        self.paint(extra, force=True)
        if self.tty:
            sys.stderr.write("\n")
            sys.stderr.flush()
        self.close()

    def close(self) -> None:
        if self._hidden:
            sys.stderr.write("\033[?25h")
            sys.stderr.flush()
            self._hidden = False

    def __enter__(self) -> Bar:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
