#!/usr/bin/env python3
"""ProxyCommand for ssh: CONNECT through the sandbox egress proxy.

Usage:
  ssh -o ProxyCommand="python3 proxy-command.py %h %p" ...

Reads the proxy URL (including credentials) from the https_proxy env var;
nothing secret is written to disk or the command line.
"""
import base64
import os
import select
import socket
import sys
import urllib.parse


def main():
    host, port = sys.argv[1], int(sys.argv[2])
    proxy = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
    if not proxy:
        sys.exit(1)
    u = urllib.parse.urlparse(proxy)
    s = socket.create_connection((u.hostname, u.port), timeout=15)
    auth = base64.b64encode(f"{u.username}:{u.password}".encode()).decode()
    s.sendall(
        f"CONNECT {host}:{port} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"Proxy-Authorization: Basic {auth}\r\n\r\n".encode()
    )
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            sys.exit(1)
        buf += chunk
    if b" 200 " not in buf.split(b"\r\n")[0]:
        sys.exit(1)
    # Relay stdin/stdout <-> socket until either side closes.
    infd, outfd = 0, 1
    while True:
        r, _, _ = select.select([infd, s.fileno()], [], [])
        if infd in r:
            data = os.read(infd, 65536)
            if not data:
                return
            s.sendall(data)
        if s.fileno() in r:
            data = s.recv(65536)
            if not data:
                return
            os.write(outfd, data)


if __name__ == "__main__":
    main()
