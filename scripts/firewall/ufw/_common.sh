#!/usr/bin/env bash
# Helpers for the ufw backend. Sourced.

need_ufw() {
    command -v ufw >/dev/null || { echo "ufw not installed" >&2; exit 1; }
    sudo -n true 2>/dev/null || { echo "need passwordless sudo for ufw" >&2; exit 1; }
}

valid_port() {
    [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || {
        echo "bad port: $1" >&2
        exit 1
    }
}

has_rule() {
    sudo -n ufw status | grep -q "$1/$2" 2>/dev/null
}

allow() {
    valid_port "$1"
    has_rule "$1" "$2" || sudo -n ufw allow "$1/$2" >/dev/null
}

deny() {
    valid_port "$1"
    has_rule "$1" "$2" && sudo -n ufw delete allow "$1/$2" >/dev/null
}
