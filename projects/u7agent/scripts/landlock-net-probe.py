#!/usr/bin/env python3
"""Landlock の net 制限が効いているかを確かめる probe。ビルド時の検査にだけ使う。

許可外ポートへの connect は Landlock が EACCES (PermissionError) で止め、許可したポートへの
connect は通常どおり失敗する (ECONNREFUSED)。errno を分けて見ないと「制限が効いている」と
「宛先が閉じている」を取り違えるため、期待する結果を引数で受け取って一致だけを見る。

使い方: landlock-net-probe.py <port> <denied|refused|connected>
"""
import socket
import sys


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: landlock-net-probe.py <port> <denied|refused|connected>\n")
        return 2
    try:
        port = int(argv[1])
    except ValueError:
        sys.stderr.write("port is not an integer: %s\n" % argv[1])
        return 2
    expected = argv[2]
    try:
        socket.create_connection(("127.0.0.1", port), 1)
    except PermissionError:
        actual = "denied"
    except OSError:
        actual = "refused"
    else:
        actual = "connected"
    if actual != expected:
        sys.stderr.write("expected %s but got %s (port %d)\n" % (expected, actual, port))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
