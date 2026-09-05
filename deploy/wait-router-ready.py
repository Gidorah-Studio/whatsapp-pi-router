#!/usr/bin/env python3
"""Read-only startup gate: require a fresh socket-open from this unit's Pi PID."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import subprocess
import sys
import time

BLOCKED = {'reauth-required', 'connection-conflict'}


def evaluate(config, events, pid, lock_pid, since):
    current = []
    for event in events:
        try:
            fresh = datetime.fromisoformat(event['timestamp'].replace('Z', '+00:00')).timestamp() >= since
        except (KeyError, TypeError, ValueError):
            continue
        if fresh and event.get('pid') == pid:
            current.append(event)
    if not current:
        return 'pending'
    last = current[-1]
    status = config.get('status')
    if isinstance(status, str) and status in BLOCKED:
        return 'blocked'
    if last.get('type') == 'extension-start' and last.get('authStatePresent') is False:
        return 'blocked'
    if last.get('type') == 'connection-open' and status == 'connected' and lock_pid == pid:
        return 'ready'
    return 'pending'


def read_json(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def read_events(path):
    try:
        with path.open('rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 65536))
            lines = f.read().decode('utf8', errors='replace').splitlines()
    except OSError:
        return []
    events = []
    for line in lines:
        try:
            event = json.loads(line)
            if isinstance(event, dict):
                events.append(event)
        except ValueError:
            pass
    return events


def wait_ready(socket, root, timeout):
    # ExecStartPost runs alongside wrapper startup. Ignore old journal entries,
    # including entries from a historical process with a reused PID.
    since = time.time() - 10
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = subprocess.run(['/usr/bin/tmux', '-S', str(socket), 'display-message',
                                     '-p', '-t', 'emily:0.0', '#{pane_pid} #{pane_dead}'],
                                    capture_output=True, text=True, timeout=3)
            parts = result.stdout.strip().split()
            if result.returncode == 0 and len(parts) == 2 and parts[0].isdigit() and parts[1] == '0':
                state = evaluate(read_json(root / 'config.json'), read_events(root / 'connection-events.jsonl'),
                                 int(parts[0]), read_json(root / 'auth.lock').get('pid'), since)
                if state == 'ready':
                    print('Startup verified: current router PID owns the lock and opened WhatsApp.', flush=True)
                    return 0
                if state == 'blocked':
                    print('WARNING: WhatsApp startup needs operator attention (missing/rejected credentials or conflict). '
                          'Console remains available; credentials will not be reset and restarts will not be forced.', flush=True)
                    return 0
        except (OSError, subprocess.TimeoutExpired):
            pass
        time.sleep(.5)
    print('Startup timed out without a verified WhatsApp socket; systemd will restart the router.', file=sys.stderr, flush=True)
    return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--timeout', type=float, default=90)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('timeout must be positive')
    return wait_ready(args.socket, args.root, args.timeout)


if __name__ == '__main__':
    sys.exit(main())
