#!/usr/bin/env bash
# Helpers for the firewalld backend. Sourced.

ZONE="${FIREWALL_ZONE:-public}"

need_firewalld() {
    command -v firewall-cmd >/dev/null || { echo "firewall-cmd missing" >&2; exit 1; }
    systemctl is-active firewalld >/dev/null 2>&1 || {
        echo "start firewalld: sudo systemctl start firewalld" >&2
        exit 1
    }
    sudo -n true 2>/dev/null || { echo "need passwordless sudo for firewall-cmd" >&2; exit 1; }
}

valid_port() {
    [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || {
        echo "bad port: $1" >&2
        exit 1
    }
}

allow() {
    valid_port "$1"
    sudo -n firewall-cmd --zone="$ZONE" --query-port="$1/$2" &>/dev/null \
        || sudo -n firewall-cmd --zone="$ZONE" --add-port="$1/$2" >/dev/null
}

deny() {
    valid_port "$1"
    sudo -n firewall-cmd --zone="$ZONE" --query-port="$1/$2" &>/dev/null \
        && sudo -n firewall-cmd --zone="$ZONE" --remove-port="$1/$2" >/dev/null
}
