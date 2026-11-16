#!/usr/bin/env python3
"""Fail-closed argv launcher; JSON policy is supplied outside the writable jail.

UAPI: https://docs.kernel.org/userspace-api/landlock.html
Only known syscall tables and ABIs are accepted. All filesystem rights of the
selected ABI are handled, including REFER, TRUNCATE and device IOCTL.
"""
import ctypes
import json
import os
import platform
import signal
import stat
import sys


class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('access', ctypes.c_uint64), ('fd', ctypes.c_int32)]


class NetRule(ctypes.Structure):
    _fields_ = [('access', ctypes.c_uint64), ('port', ctypes.c_uint64)]


def check(result):
    if result < 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return result


def restrict(policy):
    if platform.machine() not in ('x86_64', 'aarch64', 'riscv64'):
        raise RuntimeError('unknown architecture syscall table')
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    abi = check(libc.syscall(444, 0, 0, 1))
    # Refuse future ABIs rather than silently omitting new filesystem rights.
    if not 4 <= abi <= 8:
        raise RuntimeError('unsupported Landlock ABI: ' + str(abi))
    # UAPI masks and ABI compatibility switch:
    # https://docs.kernel.org/userspace-api/landlock.html#defining-and-enforcing-a-security-policy
    # ABI 4: FS bits 0..14; ABI 5 adds IOCTL_DEV (bit 15). ABIs 6..8 add no FS rights.
    # https://docs.kernel.org/userspace-api/landlock.html#filesystem-flags
    fs = (1 << (15 if abi == 4 else 16)) - 1
    net = 3  # BIND_TCP (bit 0) | CONNECT_TCP (bit 1), present since ABI 4.
    # ABI 6 scopes: ABSTRACT_UNIX_SOCKET (bit 0) | SIGNAL (bit 1).
    # https://docs.kernel.org/userspace-api/landlock.html#scope-flags
    attrs = (ctypes.c_uint64 * 3)(fs, net, 3 if abi >= 6 else 0)
    ruleset = check(libc.syscall(444, ctypes.byref(attrs), (24 if abi >= 6 else 16), 0))
    for entry in policy.get('paths', []):
        try:
            fd = os.open(entry['path'], os.O_PATH | os.O_CLOEXEC)
        except FileNotFoundError:
            if entry.get('optional', False):
                continue
            raise
        try:
            access = fs if entry['writable'] else 13  # EXECUTE | READ_FILE | READ_DIR
            if not stat.S_ISDIR(os.fstat(fd).st_mode):
                access &= 1 | 2 | 4 | (1 << 14) | (1 << 15)
            rule = PathRule(access, fd)
            check(libc.syscall(445, ruleset, 1, ctypes.byref(rule), 0))
        finally:
            os.close(fd)
    for port in policy.get('connect', []):
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise RuntimeError('invalid TCP port')
        rule = NetRule(2, port)  # CONNECT_TCP; no BIND_TCP or UDP grants
        check(libc.syscall(445, ruleset, 2, ctypes.byref(rule), 0))
    check(libc.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
    check(libc.syscall(446, ruleset, 0))
    os.close(ruleset)
    return abi


try:
    if sys.argv[1:] == ['--probe']:
        print(restrict({}))  # Probe enforcement, not just kernel support.
    else:
        with open(sys.argv[1], encoding='utf-8') as stream:
            policy = json.load(stream)
        libc = ctypes.CDLL(None, use_errno=True)
        parent = os.getppid()
        check(libc.prctl(1, signal.SIGKILL, 0, 0, 0))  # PR_SET_PDEATHSIG
        if os.getppid() != parent:
            raise RuntimeError('launcher parent exited')
        os.kill(policy['parent'], 0)  # The Bridge must still exist, including under a scope wrapper.
        restrict(policy)
        os.environ.update(policy['env'])
        os.chdir(policy['cwd'])
        os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
except Exception as error:
    print('landlock-exec: refused: ' + str(error), file=sys.stderr)
    sys.exit(126)
