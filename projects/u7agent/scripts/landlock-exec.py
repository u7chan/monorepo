#!/usr/bin/env python3
"""Landlock の exec ラッパー。bash を起動する前に許可 root の外への書き込みと、許可外ポートへの接続を EACCES にする。

pi SDK の `BashToolOptions.shellPath` に渡す前提で、SDK と同じ引数 (`-c <command>`) を受け取り、
環境変数 `U7AGENT_LANDLOCK_*` を読んでから本物の shell (U7AGENT_LANDLOCK_SHELL) を exec する。
適用に失敗したら exec せず非 0 で終了する (fail-closed)。設計は docs/sandbox.md を正とする。
"""
import ctypes
import errno
import json
import os
import stat as stat_module
import sys

SYS_CREATE_RULESET = 444
SYS_ADD_RULE = 445
SYS_RESTRICT_SELF = 446
CREATE_RULESET_VERSION = 1
RULE_PATH_BENEATH = 1
RULE_NET_PORT = 2
PR_SET_NO_NEW_PRIVS = 38
MIN_ABI_DEFAULT = 4
# network の権利 (CONNECT_TCP) は ABI 4 で入った。FS だけなら 3 でも動くが、要求は 4 に揃える
NET_MIN_ABI = 4
EXIT_FAILURE = 125
ENV_PREFIX = "U7AGENT_LANDLOCK_"

FS_WRITE_FILE = 1 << 1
FS_REMOVE_DIR = 1 << 4
FS_REMOVE_FILE = 1 << 5
FS_MAKE_CHAR = 1 << 6
FS_MAKE_DIR = 1 << 7
FS_MAKE_REG = 1 << 8
FS_MAKE_SOCK = 1 << 9
FS_MAKE_FIFO = 1 << 10
FS_MAKE_BLOCK = 1 << 11
FS_MAKE_SYM = 1 << 12
FS_REFER = 1 << 13
FS_TRUNCATE = 1 << 14

# kernel の landlock.h は BIND_TCP を bit 0、CONNECT_TCP を bit 1 に置く
NET_BIND_TCP = 1 << 0
NET_CONNECT_TCP = 1 << 1

# ディレクトリに許可する書き込み系の権利。内容への作成 / 削除 / rename をまとめて許可する
DIR_WRITE_ACCESS = (
    FS_WRITE_FILE
    | FS_REMOVE_DIR
    | FS_REMOVE_FILE
    | FS_MAKE_CHAR
    | FS_MAKE_DIR
    | FS_MAKE_REG
    | FS_MAKE_SOCK
    | FS_MAKE_FIFO
    | FS_MAKE_BLOCK
    | FS_MAKE_SYM
)
# ディレクトリ以外のパスに与えられるのは file 向けの権利だけ (MAKE_* や REFER を渡すと EINVAL)
FILE_WRITE_ACCESS = FS_WRITE_FILE

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


class RulesetAttr(ctypes.Structure):
    # ABI 4 で handled_access_net、ABI 6 で scoped が増える。使わない分は 0 のまま渡す
    # (カーネルは必要な分だけ読み、残りが 0 であることを要求する)
    _fields_ = [
        ("handled_access_fs", ctypes.c_uint64),
        ("handled_access_net", ctypes.c_uint64),
        ("scoped", ctypes.c_uint64),
    ]


class PathBeneathAttr(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int64)]


class NetPortAttr(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("port", ctypes.c_uint64)]


def fail(message):
    sys.stderr.write("u7agent-landlock: %s\n" % message)
    sys.exit(EXIT_FAILURE)


def errno_message():
    return os.strerror(ctypes.get_errno())


def create_ruleset_version():
    return libc.syscall(SYS_CREATE_RULESET, 0, 0, CREATE_RULESET_VERSION)


def handled_access(abi):
    """ruleset が既定で拒否する権利。許可 root に無い書き込みをここで塞ぐ (read は扱わない)。"""
    access = DIR_WRITE_ACCESS
    if abi >= 2:
        access |= FS_REFER
    if abi >= 3:
        access |= FS_TRUNCATE
    return access


def allowed_access(stats, abi):
    """rule が許可する権利。ディレクトリ以外にディレクトリ向けの権利を渡さない (EINVAL になる)。"""
    is_dir = stat_module.S_ISDIR(stats.st_mode)
    if not is_dir:
        access = FILE_WRITE_ACCESS
    else:
        access = DIR_WRITE_ACCESS
        if abi >= 2:
            access |= FS_REFER
    if abi >= 3:
        access |= FS_TRUNCATE
    return access


def add_net_rule(ruleset_fd, port):
    rule = NetPortAttr(NET_CONNECT_TCP, port)
    if libc.syscall(SYS_ADD_RULE, ruleset_fd, RULE_NET_PORT, ctypes.byref(rule), 0) < 0:
        fail("cannot allow port %d: %s" % (port, errno_message()))


def add_rule(ruleset_fd, path, create, abi):
    if create:
        # 無ければ作ってよいと宣言された root だけを mkdir する (要求由来のパスは作らない)
        try:
            os.makedirs(path, exist_ok=True)
        except OSError as error:
            fail("cannot create %s: %s" % (path, error.strerror or error))
    try:
        stats = os.stat(path)
    except OSError as error:
        if error.errno == errno.ENOENT and not create:
            # Landlock は実在するパスにしか rule を付けられない。無い root は黙って落とす
            return
        fail("cannot stat %s: %s" % (path, error.strerror or error))
    try:
        path_fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    except OSError as error:
        fail("cannot open %s: %s" % (path, error.strerror or error))
    try:
        rule = PathBeneathAttr(allowed_access(stats, abi), path_fd)
        if libc.syscall(SYS_ADD_RULE, ruleset_fd, RULE_PATH_BENEATH, ctypes.byref(rule), 0) < 0:
            fail("cannot restrict %s: %s" % (path, errno_message()))
    finally:
        os.close(path_fd)


def parse_port(text, token):
    try:
        port = int(text)
    except ValueError:
        fail("%sNET_PORTS is not a port or range: %s" % (ENV_PREFIX, token))
    if port < 1 or port > 65535:
        fail("%sNET_PORTS is out of range: %s" % (ENV_PREFIX, token))
    return port


def parse_net_ports(raw):
    """`443,8080,18000-18099` を展開する。未設定は None で、net を扱わない (後方互換)。

    空文字は空リスト (扱うが許可 0 件 = すべての connect を拒否) になる。未設定と同じにしない。
    """
    if raw is None:
        return None
    ports = []
    seen = set()
    for item in raw.split(","):
        token = item.strip()
        if not token:
            continue
        if "-" in token:
            start_text, _, end_text = token.partition("-")
            start = parse_port(start_text, token)
            end = parse_port(end_text, token)
            if end < start:
                fail("%sNET_PORTS has a reversed range: %s" % (ENV_PREFIX, token))
            candidates = range(start, end + 1)
        else:
            candidates = (parse_port(token, token),)
        for port in candidates:
            if port not in seen:
                seen.add(port)
                ports.append(port)
    return ports


def parse_rules(raw):
    try:
        rules = json.loads(raw)
    except ValueError as error:
        fail("%sRULES is not valid JSON: %s" % (ENV_PREFIX, error))
    if not isinstance(rules, list):
        fail("%sRULES must be a JSON array" % ENV_PREFIX)
    for rule in rules:
        if not isinstance(rule, dict) or not isinstance(rule.get("path"), str):
            fail("each %sRULES entry needs a string path" % ENV_PREFIX)
    return rules


def read_min_abi():
    try:
        return int(os.environ.get(ENV_PREFIX + "MIN_ABI", str(MIN_ABI_DEFAULT)))
    except ValueError:
        fail("%sMIN_ABI is not an integer" % ENV_PREFIX)


def abi_mode():
    abi = create_ruleset_version()
    if abi < 0:
        error = ctypes.get_errno()
        if error in (errno.ENOSYS, errno.EOPNOTSUPP, errno.ENOTSUP):
            # カーネルが Landlock に対応していない (呼び出し側は 0 を「利用不可」として扱う)
            print(0)
            return 0
        fail("cannot query the landlock ABI: %s" % errno_message())
    print(abi)
    return 0


def main(argv):
    if not sys.platform.startswith("linux"):
        fail("landlock is only available on Linux")
    if argv[1:] == ["--abi"]:
        return abi_mode()

    shell = os.environ.get(ENV_PREFIX + "SHELL", "")
    if not shell:
        fail("%sSHELL is not set" % ENV_PREFIX)
    rules = parse_rules(os.environ.get(ENV_PREFIX + "RULES", "[]"))
    net_ports = parse_net_ports(os.environ.get(ENV_PREFIX + "NET_PORTS"))
    min_abi = read_min_abi()

    abi = create_ruleset_version()
    if abi < 0:
        fail("landlock is not supported: %s" % errno_message())
    if abi < min_abi:
        fail("landlock ABI %d is older than the required %d" % (abi, min_abi))
    if net_ports is not None and abi < NET_MIN_ABI:
        fail("landlock ABI %d cannot restrict the network (ABI %d or newer is required)" % (abi, NET_MIN_ABI))

    ruleset = RulesetAttr(
        handled_access(abi),
        NET_CONNECT_TCP if net_ports is not None else 0,
        0,
    )
    ruleset_fd = libc.syscall(SYS_CREATE_RULESET, ctypes.byref(ruleset), ctypes.sizeof(ruleset), 0)
    if ruleset_fd < 0:
        fail("cannot create a landlock ruleset: %s" % errno_message())
    for rule in rules:
        add_rule(ruleset_fd, rule["path"], rule.get("create") is True, abi)
    for port in net_ports or ():
        add_net_rule(ruleset_fd, port)

    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        fail("cannot set no_new_privs: %s" % errno_message())
    if libc.syscall(SYS_RESTRICT_SELF, ruleset_fd, 0) < 0:
        fail("cannot apply the landlock ruleset: %s" % errno_message())
    os.close(ruleset_fd)

    # 内部 env は子へ残さない (権利セットや許可 root の再注入をさせない)
    env = {key: value for key, value in os.environ.items() if not key.startswith(ENV_PREFIX)}
    os.execvpe(shell, [shell] + argv[1:], env)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
