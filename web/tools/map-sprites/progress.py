"""In-place progress line, same idea as map-tiles/import.sh.

Rewrites one line (CR + erase-tail). A newline is only emitted when a bar
finishes, so the next stage can start. Set NO_TTY=1 for line-at-a-time logs.
"""

from __future__ import annotations

import os
import sys
import time


def _inplace() -> bool:
    if os.environ.get("NO_TTY"):
        return False
    if os.environ.get("TERM", "") == "dumb":
        return False
    # Makefile always exports COLUMNS into the container. Prefer in-place even
    # when compose did not attach a tty (stderr.isatty() is then false).
    if os.environ.get("COLUMNS", "").isdigit():
        return True
    return sys.stderr.isatty() or sys.stdout.isatty()


def _cols() -> int:
    raw = os.environ.get("COLUMNS", "")
    if raw.isdigit():
        return max(20, int(raw))
    try:
        return max(20, os.get_terminal_size(2).columns)
    except OSError:
        try:
            return max(20, os.get_terminal_size(1).columns)
        except OSError:
            return 80


def _eta(seconds: float | None) -> str:
    if seconds is None or seconds < 0:
        return "--"
    sec = int(seconds)
    if sec >= 3600:
        return f"{sec // 3600}h{(sec % 3600) // 60:02d}m"
    return f"{sec // 60}m{sec % 60:02d}s"


def _clip(text: str, width: int) -> str:
    if width <= 0:
        return ""
    if len(text) <= width:
        return text
    if width <= 1:
        return text[:width]
    return text[: width - 1] + "…"


class Bar:
    def __init__(self, label: str, total: int) -> None:
        self.label = label
        self.total = max(int(total), 1)
        self.done = 0
        self.start = time.monotonic()
        self.inplace = _inplace()
        self._last_static = 0.0
        self._hidden = False
        if self.inplace:
            sys.stderr.write("\033[?25l")
            self._hidden = True

    def tick(self, n: int = 1, extra: str = "") -> None:
        self.done = min(self.total, self.done + n)
        self.paint(extra)

    def paint(self, extra: str = "", force: bool = False) -> None:
        now = time.monotonic()
        if not self.inplace and not force and now - self._last_static < 2:
            return
        self._last_static = now
        elapsed = max(now - self.start, 0.001)
        rate = self.done / elapsed
        remain = (self.total - self.done) / rate if rate > 0 and self.done < self.total else 0
        pct = 100.0 * self.done / self.total
        extra = extra.replace("\n", " ").replace("\r", " ").strip()
        suffix = f"  {pct:5.1f}%  {self.done}/{self.total}  {rate:.1f}/s  eta {_eta(remain)}"
        prefix = f"{self.label} "
        cols = _cols()
        # Leave one column free: a wrap plus CR only returns to the wrapped row.
        usable = max(20, cols - 1)
        extra_room = usable - len(prefix) - len(suffix) - 12
        if extra and extra_room >= 8:
            suffix += "  " + _clip(extra, extra_room)
        bar_w = usable - len(prefix) - len(suffix) - 2
        if bar_w < 8:
            suffix = f"  {pct:5.1f}%  {self.done}/{self.total}"
            bar_w = max(8, usable - len(prefix) - len(suffix) - 2)
        filled = int(bar_w * (self.done / self.total))
        if self.done >= self.total:
            filled = bar_w
        filled = max(0, min(bar_w, filled))
        body = "=" * filled + " " * (bar_w - filled)
        if 0 < self.done < self.total and 0 < filled < bar_w:
            body = body[: filled - 1] + ">" + body[filled:]
        line = _clip(f"{prefix}[{body}]{suffix}", usable)
        if self.inplace:
            sys.stderr.write(f"\r{line}\033[K")
        else:
            sys.stderr.write(line + "\n")
        sys.stderr.flush()

    def finish(self, extra: str = "") -> None:
        self.done = self.total
        self.paint(extra, force=True)
        if self.inplace:
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
