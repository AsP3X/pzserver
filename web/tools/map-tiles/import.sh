#!/bin/sh
# Copy /src/tiles.sqlite into the named volume at /pack/tiles.sqlite.
#
# Progress goes to stderr, like wget/curl/pv: stdout stays free, and stderr
# is unbuffered so a CR-only line actually appears. On a TTY the same line is
# rewritten in place (CR + CSI K). Off a TTY (pipe, CI, docker without -t)
# it falls back to occasional full lines so logs stay readable.
set -eu

SRC=/src/tiles.sqlite
DST=/pack/tiles.sqlite

if [ ! -f "$SRC" ]; then
    echo "FAIL: $SRC is missing" >&2
    exit 1
fi

# Human size: 24.0G, 88.4M, 512K, 123B. One decimal from the megabyte up so
# a 24 GB copy does not sit on the same integer for half a minute.
fmt_bytes() {
    awk -v b="$1" 'BEGIN {
        if (b < 0) b = 0
        if (b >= 1073741824) printf "%.1fG", b / 1073741824
        else if (b >= 1048576) printf "%.1fM", b / 1048576
        else if (b >= 1024) printf "%.0fK", b / 1024
        else printf "%dB", b
    }'
}

fmt_eta() {
    sec=$1
    if [ "$sec" -lt 0 ]; then
        sec=0
    fi
    if [ "$sec" -ge 3600 ]; then
        printf "%dh%02dm" $((sec / 3600)) $(((sec % 3600) / 60))
    else
        printf "%dm%02ds" $((sec / 60)) $((sec % 60))
    fi
}

# True when rewriting one line is safe: real tty, not TERM=dumb, operator
# did not ask us to stay still. docker run -t is what makes this true inside
# the Alpine container; the Makefile only passes -t when the host is a tty.
dynamic=0
if [ -t 2 ] && [ "${TERM:-}" != "dumb" ] && [ -z "${NO_TTY:-}" ]; then
    dynamic=1
fi

color=0
if [ "$dynamic" -eq 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
    color=1
fi

cols=${COLUMNS:-0}
if [ "$cols" -eq 0 ] 2>/dev/null; then
    cols=$(stty size 0<&2 2>/dev/null | awk '{print $2}')
fi
case "$cols" in
    ''|*[!0-9]*) cols=80 ;;
esac
if [ "$cols" -lt 20 ]; then
    cols=20
fi

# CSI sequences used below (ECMA-48, same ones wget/curl use):
#   CR        \r       go to column 0 of this line
#   EL 0      ESC [ K  erase from cursor to end of line (drops leftover glyphs
#                      when the new text is shorter than the previous)
#   DECTCEM   ESC [ ? 25 l/h  hide/show cursor so it does not flicker on the bar
CR=$(printf '\r')
EL=$(printf '\033[K')
HIDE=$(printf '\033[?25l')
SHOW=$(printf '\033[?25h')
RESET=$(printf '\033[0m')
GREEN=
BOLD=
if [ "$color" -eq 1 ]; then
    GREEN=$(printf '\033[32m')
    BOLD=$(printf '\033[1m')
fi

cursor_hidden=0
hide_cursor() {
    if [ "$dynamic" -eq 1 ] && [ "$cursor_hidden" -eq 0 ]; then
        printf '%s' "$HIDE" >&2
        cursor_hidden=1
    fi
}

show_cursor() {
    if [ "$cursor_hidden" -eq 1 ]; then
        printf '%s' "$SHOW" >&2
        cursor_hidden=0
    fi
}

# Draw one frame. On a tty: CR + line + erase-tail, no newline. Off a tty:
# a normal line, and the caller throttles those so logs are not a flood.
#
# The bar width is derived from COLUMNS minus the stats suffix so the whole
# line cannot wrap. A wrap plus CR only returns to the start of the *wrapped*
# row, which is how in-place bars destroy the scrollback.
paint() {
    now=$1
    total=$2
    rate=$3
    eta=$4

    line=$(awk -v now="$now" -v total="$total" -v rate="$rate" -v eta="$eta" \
        -v cols="$cols" -v green="$GREEN" -v bold="$BOLD" -v reset="$RESET" '
        BEGIN {
            if (total <= 0) total = 1
            if (now < 0) now = 0
            if (now > total) now = total
            pct = 100.0 * now / total

            # Sizes first so the suffix length is known before the bar is sized.
            ntxt = hb(now)
            ttxt = hb(total)
            if (rate > 0) rtxt = hb(rate) "/s"
            else rtxt = "--/s"
            if (eta == "" || eta == "--") etxt = "eta --"
            else etxt = "eta " eta

            suffix = sprintf("  %5.1f%%  %s / %s  %s  %s", pct, ntxt, ttxt, rtxt, etxt)
            # Keep one column free: some terminals wrap when the cursor sits on
            # the last column even without a newline.
            bar = cols - length(suffix) - 3
            if (bar < 8) {
                suffix = sprintf("  %5.1f%%  %s / %s", pct, ntxt, ttxt)
                bar = cols - length(suffix) - 3
            }
            if (bar < 8) bar = 8

            # Divide first so 24 GB * bar width cannot overflow a 32-bit awk.
            filled = int(bar * (now / total))
            if (now >= total) filled = bar
            if (filled < 0) filled = 0
            if (filled > bar) filled = bar

            body = ""
            for (i = 1; i <= bar; i++) {
                if (i <= filled) body = body "="
                else body = body " "
            }
            # wget-style head so a half-empty bar still reads as "moving".
            if (now > 0 && now < total && filled < bar && filled > 0) {
                body = substr(body, 1, filled - 1) ">" substr(body, filled + 1)
            }

            printf "[%s%s%s]%s%s%s", green, body, reset, bold, suffix, reset
        }
        function hb(b) {
            if (b < 0) b = 0
            if (b >= 1073741824) return sprintf("%.1fG", b / 1073741824)
            if (b >= 1048576) return sprintf("%.1fM", b / 1048576)
            if (b >= 1024) return sprintf("%.0fK", b / 1024)
            return sprintf("%dB", b)
        }
    ')

    # Truncate on byte length as a last guard if COLUMNS was a lie. Never cut
    # inside an ESC sequence: strip by reprinting without colour if needed.
    if [ "$dynamic" -eq 1 ]; then
        printf '%s%s%s' "$CR" "$line" "$EL" >&2
    else
        printf '%s\n' "$line" >&2
    fi
}

total=$(stat -c%s "$SRC")
if [ "$total" -le 0 ]; then
    echo "FAIL: $SRC is empty" >&2
    exit 1
fi

echo "==> importing tiles.sqlite ($(fmt_bytes "$total")) into volume pz-map-tiles-sqlite" >&2

rm -f "$DST"
cp "$SRC" "$DST" &
pid=$!

kill_cp() {
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
}

on_signal() {
    show_cursor
    if [ "$dynamic" -eq 1 ]; then
        printf '\n' >&2
    fi
    kill_cp
    echo "FAIL: import interrupted" >&2
    exit 130
}

trap on_signal INT TERM
trap show_cursor EXIT

hide_cursor

start=$(date +%s)
prev_bytes=0
smooth=0
static_last=0

# Dynamic tty: ~5 Hz so the bar moves with the copy. Rate/ETA only change
# when the wall clock second does (`date +%s` has no sub-second on busybox).
# Static: one line every 5s so a redirected log is usable.
if [ "$dynamic" -eq 1 ]; then
    tick=0.2
    static_every=0
else
    tick=1
    static_every=5
fi

while kill -0 "$pid" 2>/dev/null; do
    now=$(stat -c%s "$DST" 2>/dev/null || echo 0)
    wall=$(date +%s)
    elapsed=$((wall - start))

    # Average since start, EMA-smoothed once per second. Sub-second ticks
    # keep the bar moving but do not invent a rate from a 1-second clock.
    if [ "$elapsed" -ge 1 ]; then
        instant=$((now / elapsed))
        if [ "$smooth" -eq 0 ]; then
            smooth=$instant
        elif [ "$now" -ne "$prev_bytes" ]; then
            smooth=$(( (smooth * 7 + instant * 3) / 10 ))
            prev_bytes=$now
        fi
    fi

    if [ "$smooth" -gt 0 ] && [ "$now" -lt "$total" ] && [ "$elapsed" -ge 2 ]; then
        remain=$(( (total - now) / smooth ))
        eta=$(fmt_eta "$remain")
    else
        eta=--
    fi

    if [ "$dynamic" -eq 1 ]; then
        paint "$now" "$total" "$smooth" "$eta"
    else
        if [ $((wall - static_last)) -ge "$static_every" ]; then
            paint "$now" "$total" "$smooth" "$eta"
            static_last=$wall
        fi
    fi

    sleep "$tick"
done

set +e
wait "$pid"
status=$?
set -e
if [ "$status" -ne 0 ]; then
    show_cursor
    if [ "$dynamic" -eq 1 ]; then
        printf '\n' >&2
    fi
    echo "FAIL: copy exited $status" >&2
    exit "$status"
fi

got=$(stat -c%s "$DST")
if [ "$got" -ne "$total" ]; then
    show_cursor
    if [ "$dynamic" -eq 1 ]; then
        printf '\n' >&2
    fi
    echo "FAIL: copied $got bytes, expected $total" >&2
    exit 1
fi

# Final 100% frame, then a newline so the finished bar stays in scrollback
# and the next "==>" starts on its own line.
paint "$got" "$total" "$smooth" "$(fmt_eta 0)"
if [ "$dynamic" -eq 1 ]; then
    printf '\n' >&2
fi
show_cursor

chown 10001:10001 /pack /pack/tiles.sqlite
chmod 775 /pack
chmod 664 /pack/tiles.sqlite
echo "==> imported $(fmt_bytes "$got")  $(ls -lh "$DST" | awk '{print $1, $3":"$4}')" >&2
echo "==> done. start web-api so it opens the new pack." >&2
