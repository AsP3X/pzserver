"""In-place progress line, same idea as map-tiles/import.sh.

Rewrites one line (CR + erase-tail). A newline is only emitted when a bar
finishes, so the next stage can start. Set NO_TTY=1 for line-at-a-time logs.
"""

from __future__ import annotations

import os
import sys
import time
from collections import deque
from collections.abc import Callable


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
    if sec >= 86400:
        return f"{sec // 86400}d{(sec % 86400) // 3600:02d}h"
    if sec >= 3600:
        return f"{sec // 3600}h{(sec % 3600) // 60:02d}m"
    return f"{sec // 60}m{sec % 60:02d}s"


def _smooth_eta(seconds: float | None) -> float | None:
    """Round remaining time so the number does not jump every tick."""
    if seconds is None or seconds < 0:
        return None
    if seconds < 20:
        return seconds
    if seconds < 90:
        return 5 * round(seconds / 5)
    if seconds < 600:
        return 10 * round(seconds / 10)
    if seconds < 3600:
        return 30 * round(seconds / 30)
    return 60 * round(seconds / 60)


def _clip(text: str, width: int) -> str:
    if width <= 0:
        return ""
    if len(text) <= width:
        return text
    if width <= 1:
        return text[:width]
    return text[: width - 1] + "…"


class Bar:
    def __init__(
        self,
        label: str,
        total: int,
        *,
        done: int = 0,
        work_done: float = 0.0,
        work_total: float | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.label = label
        self.total = max(int(total), 1)
        self.done = max(0, min(self.total, int(done)))
        self.work_done = float(work_done)
        self.work_total = float(self.total if work_total is None else work_total)
        self._clock = clock
        self.start = clock()
        self.session_done = self.done
        self.session_work = self.work_done
        self.inplace = _inplace()
        self._last_static = 0.0
        self._hidden = False
        self._hist: deque[tuple[float, float]] = deque(maxlen=40)
        self._hist.append((self.start, self.work_done))
        if self.inplace:
            sys.stderr.write("\033[?25l")
            self._hidden = True

    def tick(self, n: int = 1, extra: str = "", work: float | None = None) -> None:
        self.done = min(self.total, self.done + n)
        self.work_done += float(n if work is None else work)
        now = self._clock()
        self._hist.append((now, self.work_done))
        self.paint(extra)

    def eta_seconds(self) -> float | None:
        if self.done >= self.total:
            return 0.0
        remaining = self.work_total - self.work_done
        if remaining <= 0:
            return 0.0
        now = self._clock()
        elapsed = now - self.start
        progressed = self.work_done - self.session_work
        ticks = self.done - self.session_done
        if progressed <= 0 or ticks < 3 or elapsed < 2.0:
            return None
        overall = progressed / elapsed
        window = self._window_rate(now)
        rate = 0.7 * window + 0.3 * overall if window else overall
        if rate <= 0:
            return None
        return remaining / rate

    def _window_rate(self, now: float) -> float | None:
        if len(self._hist) < 2:
            return None
        t0, w0 = self._hist[0]
        for t, w in self._hist:
            if now - t <= 12:
                t0, w0 = t, w
                break
        dt = now - t0
        dw = self.work_done - w0
        if dt < 0.75 or dw <= 0:
            return None
        return dw / dt

    def paint(self, extra: str = "", force: bool = False) -> None:
        now = self._clock()
        if not self.inplace and not force and now - self._last_static < 2:
            return
        self._last_static = now
        elapsed = max(now - self.start, 0.0)
        ticks = self.done - self.session_done
        item_rate = ticks / elapsed if elapsed > 0.2 and ticks > 0 else None
        remain = _smooth_eta(self.eta_seconds())
        pct = 100.0 * self.done / self.total
        extra = extra.replace("\n", " ").replace("\r", " ").strip()
        rate_s = f"{item_rate:.1f}/s" if item_rate is not None else "--/s"
        suffix = (
            f"  {pct:5.1f}%  {self.done}/{self.total}  {rate_s}"
            f"  {_eta(elapsed)} elapsed  eta {_eta(remain)}"
        )
        prefix = f"{self.label} "
        cols = _cols()
        # Leave one column free: a wrap plus CR only returns to the wrapped row.
        usable = max(20, cols - 1)
        extra_room = usable - len(prefix) - len(suffix) - 12
        if extra and extra_room >= 8:
            suffix += "  " + _clip(extra, extra_room)
        bar_w = usable - len(prefix) - len(suffix) - 2
        if bar_w < 8:
            suffix = f"  {pct:5.1f}%  {self.done}/{self.total}  eta {_eta(remain)}"
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

    def interrupt(self) -> None:
        """Leave the current line in place so the checkpoint message can follow."""
        if self.inplace:
            sys.stderr.write("\n")
            sys.stderr.flush()
        self.close()

    def finish(self, extra: str = "") -> None:
        self.done = self.total
        self.work_done = max(self.work_done, self.work_total)
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
