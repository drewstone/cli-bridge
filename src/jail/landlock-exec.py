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


class CapabilityHeader(ctypes.Structure):
    _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]


class CapabilityData(ctypes.Structure):
    _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32),
                ('inheritable', ctypes.c_uint32)]


class OpenHow(ctypes.Structure):
    _fields_ = [('flags', ctypes.c_uint64), ('mode', ctypes.c_uint64), ('resolve', ctypes.c_uint64)]


def open_path(libc, path):
    # openat2 is syscall 437 on every admitted architecture; reject all symlink components atomically.
    how = OpenHow(os.O_PATH | os.O_CLOEXEC, 0, 0x04)  # RESOLVE_NO_SYMLINKS
    return check(libc.syscall(437, -100, path.encode(), ctypes.byref(how), ctypes.sizeof(how)))


def restrict(policy):
    if platform.machine() not in ('x86_64', 'aarch64', 'riscv64'):
        raise RuntimeError('unknown architecture syscall table')
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    # ABIs accepted here have no capability mediation. Refuse privileged launchers.
    header = CapabilityHeader(0x20080522, 0)  # Linux capability ABI v3 (two u32 words).
    capabilities = (CapabilityData * 2)()
    check(libc.capget(ctypes.byref(header), ctypes.byref(capabilities)))
    if os.geteuid() == 0 or any(c.effective or c.permitted or c.inheritable for c in capabilities):
        raise RuntimeError('Landlock requires a non-root user with no Linux capabilities')
    os.close(open_path(libc, '/'))  # Availability includes the path-resolution primitive.
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
            fd = open_path(libc, entry['path'])
        except FileNotFoundError:
            if entry.get('optional', False):
                continue
            raise
        try:
            identity = os.fstat(fd)
            if (stat.S_ISLNK(identity.st_mode) or str(identity.st_dev) != entry['dev']
                    or str(identity.st_ino) != entry['ino']):
                raise RuntimeError('path identity changed before enforcement')
            access = fs if entry['writable'] else 13  # EXECUTE | READ_FILE | READ_DIR
            if not stat.S_ISDIR(identity.st_mode):
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
        # The outer scope may need its bus transport; the confined payload must not inherit it.
        socket_env = {'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_AGENT_INFO',
                      'GNOME_KEYRING_CONTROL', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
                      'ICEAUTHORITY', 'SESSION_MANAGER', 'PULSE_SERVER', 'PIPEWIRE_REMOTE',
                      'SWAYSOCK', 'I3SOCK', 'TMUX', 'STY', 'DOCKER_HOST', 'CONTAINER_HOST'}
        for key in list(os.environ):
            if key.startswith('DBUS_') or key.endswith(('_SOCK', '_SOCKET')) or key in socket_env:
                os.environ.pop(key, None)
        os.chdir(policy['cwd'])
        for name in ('SIGPIPE', 'SIGXFSZ'):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), signal.SIG_DFL)
        os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
except Exception as error:
    print('landlock-exec: refused: ' + str(error), file=sys.stderr)
    sys.exit(126)
