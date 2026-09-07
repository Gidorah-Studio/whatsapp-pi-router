from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('readiness', Path(__file__).resolve().parents[1] / 'deploy/wait-router-ready.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ReadinessTests(unittest.TestCase):
    def event(self, **changes):
        return {'type': 'connection-open', 'pid': 123,
                'timestamp': datetime.fromtimestamp(200, timezone.utc).isoformat(), **changes}

    def test_ready_requires_fresh_open_and_matching_lock_owner(self):
        self.assertEqual(m.evaluate({'status': 'connected'}, [self.event()], 123, 123, 100), 'ready')
        self.assertEqual(m.evaluate({'status': 'connected'}, [self.event()], 123, 999, 100), 'pending')
        self.assertEqual(m.evaluate({'status': 'connected'}, [self.event(pid=999)], 123, 123, 100), 'pending')
        self.assertEqual(m.evaluate({'status': 'connected'}, [self.event()], 123, 123, 300), 'pending')

    def test_stale_connected_config_and_reconnect_are_not_ready(self):
        self.assertEqual(m.evaluate({'status': 'connected'}, [], 123, 123, 100), 'pending')
        self.assertEqual(m.evaluate({'status': 'reconnecting'}, [self.event()], 123, 123, 100), 'pending')
        self.assertEqual(m.evaluate({'status': 'connected'}, [self.event(), self.event(type='connection-close')], 123, 123, 100), 'pending')

    def test_auth_and_conflict_require_operator_not_restart_loop(self):
        for status in ['reauth-required', 'connection-conflict']:
            self.assertEqual(m.evaluate({'status': status}, [self.event(type='extension-start')], 123, None, 100), 'blocked')
        self.assertEqual(m.evaluate({'status': 'stopped'}, [self.event(type='extension-start', authStatePresent=False)], 123, None, 100), 'blocked')

    def test_old_auth_failure_cannot_block_new_process(self):
        self.assertEqual(m.evaluate({'status': 'reauth-required'}, [self.event(pid=999)], 123, 999, 100), 'pending')

    def test_corrupt_or_incomplete_state_stays_pending(self):
        self.assertEqual(m.evaluate({'status': {}}, [self.event(timestamp='broken')], 123, 123, 100), 'pending')
        self.assertEqual(m.evaluate({'status': {}}, [self.event()], 123, 123, 100), 'pending')
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'state.json'
            self.assertEqual(m.read_json(p), {})
            p.write_text('{incomplete')
            self.assertEqual(m.read_json(p), {})
            p.write_text('[]')
            self.assertEqual(m.read_json(p), {})

    def test_custom_and_legacy_session_targeting(self):
        for session in ['sales', None]:
            with self.subTest(session=session), \
                 patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '123 0', '')) as run, \
                 patch.object(m, 'read_json', return_value={}), \
                 patch.object(m, 'read_events', return_value=[]), \
                 patch.object(m, 'evaluate', return_value='ready'):
                kwargs = {} if session is None else {'session': session}
                self.assertEqual(m.wait_ready(Path('/tmp/private.sock'), Path('/tmp/state'), 1, **kwargs), 0)
                argv = run.call_args.args[0]
                self.assertEqual(argv[argv.index('-t') + 1], f'{session or "emily"}:0.0')
                self.assertEqual(argv[argv.index('-S') + 1], '/tmp/private.sock')

    def test_cli_passes_session_to_readiness(self):
        with patch.object(m.sys, 'argv', ['ready', '--socket', '/tmp/private.sock', '--root', '/tmp/state', '--session', 'support']), \
             patch.object(m, 'wait_ready', return_value=0) as wait:
            self.assertEqual(m.main(), 0)
            wait.assert_called_once_with(Path('/tmp/private.sock'), Path('/tmp/state'), 90, 'support')

    def test_cli_rejects_invalid_session(self):
        for name in ['', 'bad:0', 'bad.name', 'bad\nname']:
            with self.subTest(name=name), patch.object(m.sys, 'argv', ['ready', '--socket', '/tmp/private.sock', '--root', '/tmp/state', '--session', name]), \
                 patch.object(m, 'wait_ready') as wait, patch.object(m.sys, 'stderr'):
                with self.assertRaises(SystemExit):
                    m.main()
                wait.assert_not_called()

    def test_partial_journal_line_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'events.jsonl'
            p.write_text('broken\n{"type":"connection-open"}\n{partial')
            self.assertEqual(m.read_events(p), [{'type': 'connection-open'}])


if __name__ == '__main__':
    unittest.main()
