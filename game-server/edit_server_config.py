#!/usr/bin/env python3
"""Replacement config editor that doesn't corrupt PZ ini files with [ServerConfig] headers."""
import sys
import re

if len(sys.argv) < 3 or len(sys.argv) > 4:
    print("Usage: edit_server_config.py <config_file> <key> [<value>]")
    sys.exit(1)

config_file = sys.argv[1]
key = sys.argv[2]

try:
    with open(config_file, "r") as f:
        lines = f.readlines()
except FileNotFoundError:
    sys.stderr.write(f"{config_file} not found!\n")
    sys.exit(1)

if len(sys.argv) == 3:
    # Read mode
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(f"{key}="):
            print(stripped[len(key) + 1:])
            break
else:
    # Write mode
    value = sys.argv[3]
    found = False
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(f"{key}="):
            new_lines.append(f"{key}={value}\n")
            found = True
        else:
            new_lines.append(line)

    if not found:
        new_lines.append(f"{key}={value}\n")

    with open(config_file, "w") as f:
        f.writelines(new_lines)
