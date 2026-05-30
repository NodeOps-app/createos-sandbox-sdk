#!/usr/bin/env python3
"""Tiny stdin → kernel-daemon → stdout shim.

Reads code from stdin, opens a fresh Unix-socket connection to the
long-lived kernel daemon, sends the JSON request, prints the JSON
reply on stdout. One process per cell; the daemon keeps the
InteractiveShell state alive between calls.
"""
import json
import socket
import sys

SOCK_PATH = "/tmp/kernel.sock"


def main() -> int:
    code = sys.stdin.read()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(SOCK_PATH)
    s.sendall((json.dumps({"code": code}) + "\n").encode("utf-8"))
    s.shutdown(socket.SHUT_WR)
    buf = bytearray()
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        buf.extend(chunk)
    sys.stdout.write(buf.decode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
