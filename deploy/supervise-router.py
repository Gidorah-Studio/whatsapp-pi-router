#!/usr/bin/env python3
"""Keep a real Pi TTY while giving systemd ownership of its process lifetime.

Only supervises processes, not WhatsApp authentication. Never reads credentials,
resets sessions, submits prompts, or silently bypasses a router instance lock.
"""
import argparse
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import time


def tmux(socket, *args):
    return subprocess.run(
        ['/usr/bin/tmux', '-S', str(socket), '-f', '/dev/null', *args],
        capture_output=True, text=True, timeout=5,
    )


def pane_pid(socket, pane):
    result = tmux(socket, 'display-message', '-p', '-t', pane, '#{pane_pid} #{pane_dead}')
    if result.returncode:
        return None
    parts = result.stdout.strip().split()
    if len(parts) != 2 or parts[1] != '0' or not parts[0].isdigit():
        return None
    pid = int(parts[0])
    return pid if pid > 1 else None


def stop_pane(socket, pane, pid, timeout):
    # Verify that tmux still owns this PID before signalling it.
    if pane_pid(socket, pane) != pid:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pane_pid(socket, pane) != pid:
            return
        time.sleep(0.2)
    print('Graceful stop timed out; closing dedicated tmux server.', flush=True)


def supervise(args):
    stopping = False
    owned = False
    pane = None
    pid = None

    def request_stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    args.socket.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Never adopt or kill someone else's existing terminal/server.
    if tmux(args.socket, 'list-sessions').returncode == 0:
        raise RuntimeError('Dedicated tmux socket already has a live session; refusing takeover')
    try:
        command = 'exec ' + shlex.join(args.command)
        result = tmux(args.socket, 'new-session', '-d', '-s', args.session,
                      '-x', '120', '-y', '50', '-c', args.cwd,
                      '-P', '-F', '#{pane_id} #{pane_pid}', command)
        if result.returncode:
            raise RuntimeError('Could not start the dedicated tmux session')
        owned = True
        fields = result.stdout.strip().split()
        if len(fields) != 2 or not fields[0].startswith('%') or not fields[1].isdigit():
            raise RuntimeError('Invalid tmux process metadata')
        pane, pid = fields[0], int(fields[1])
        if pid <= 1:
            raise RuntimeError('Invalid child PID')
        print(f'Router TTY started; pane={pane}; pid={pid}.', flush=True)
        while not stopping:
            if pane_pid(args.socket, pane) != pid:
                print('Router process exited; requesting systemd restart.', flush=True)
                return 1
            time.sleep(1)
        print('Service stop requested; stopping router gracefully.', flush=True)
        return 0
    finally:
        if owned:
            try:
                if pane is not None and pid is not None:
                    stop_pane(args.socket, pane, pid, args.stop_timeout)
            finally:
                # This server is private to this unit. Never use the default socket.
                tmux(args.socket, 'kill-server')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', type=Path, required=True)
    parser.add_argument('--session', default='emily')
    parser.add_argument('--cwd', default='/root')
    parser.add_argument('--stop-timeout', type=float, default=20)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command[:1] == ['--']:
        args.command = args.command[1:]
    if not args.command or not Path(args.command[0]).is_absolute():
        parser.error('An absolute executable path is required after --')
    if not args.socket.is_absolute() or args.stop_timeout <= 0:
        parser.error('Use an absolute socket path and positive stop timeout')
    try:
        return supervise(args)
    except Exception as error:
        # Never log a subprocess environment, terminal contents, or secret values.
        print(f'Router supervisor failed: {type(error).__name__}.', file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
