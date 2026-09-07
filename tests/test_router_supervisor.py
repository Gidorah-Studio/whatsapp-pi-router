import argparse
import importlib.util
from pathlib import Path
import signal
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).resolve().parents[1] / 'deploy/supervise-router.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def result(code=0, output=''):
    return subprocess.CompletedProcess([], code, output, '')


class SupervisorTests(unittest.TestCase):
    def args(self):
        return argparse.Namespace(socket=Path('/tmp/isolated-test/tmux.sock'), session='emily',
                                  cwd='/root', command=['/usr/bin/pi', '--whatsapp-pi-online'], stop_timeout=1)

    def test_generic_unit_uses_matching_explicit_session_and_socket(self):
        unit = (Path(__file__).resolve().parents[1] / 'deploy/whatsapp-router.service.in').read_text()
        values = {'AGENT': 'sales', 'USER': 'sales', 'HOME': '/home/sales',
                  'WORKDIR': '/home/sales/work', 'PI_CONFIG_DIR': '/home/sales/.pi/agent',
                  'NODE_BIN_DIR': '/opt/node/bin', 'PI_BIN': '/opt/node/bin/pi',
                  'ROUTER_STATE_DIR': '/home/sales/.pi/agent/extensions/whatsapp-pi'}
        for key, value in values.items():
            unit = unit.replace(f'@{key}@', value)
        directives = '\n'.join(line for line in unit.splitlines() if not line.startswith('#'))
        self.assertNotIn('@', directives)
        self.assertNotIn('/root', directives)
        self.assertNotIn('emily', directives)
        commands = [line for line in unit.splitlines() if line.startswith(('ExecStart=', 'ExecStartPost='))]
        self.assertEqual(len(commands), 2)
        for command in commands:
            self.assertIn('--session sales', command)
            self.assertIn('--socket /run/whatsapp-router-sales/tmux.sock', command)
        self.assertIn('--cwd /home/sales/work', commands[0])
        self.assertIn('--root /home/sales/.pi/agent/extensions/whatsapp-pi', commands[1])

    def test_cli_accepts_generic_paths_and_preserves_legacy_defaults(self):
        for extra, session, cwd in [([], 'emily', '/root'), (['--session', 'sales', '--cwd', '/home/sales'], 'sales', '/home/sales')]:
            with self.subTest(session=session), patch.object(m.sys, 'argv', ['supervisor', '--socket', '/tmp/private.sock', *extra, '--', '/usr/bin/pi']), \
                 patch.object(m, 'supervise', return_value=0) as run:
                self.assertEqual(m.main(), 0)
                args = run.call_args.args[0]
                self.assertEqual((args.session, args.cwd), (session, cwd))

    def test_cli_rejects_invalid_session_and_relative_cwd(self):
        for extra in [['--session', 'bad:0'], ['--session', ''], ['--cwd', 'relative']]:
            with self.subTest(extra=extra), patch.object(m.sys, 'argv', ['supervisor', '--socket', '/tmp/private.sock', *extra, '--', '/usr/bin/pi']), \
                 patch.object(m, 'supervise') as run, patch.object(m.sys, 'stderr'):
                with self.assertRaises(SystemExit):
                    m.main()
                run.assert_not_called()

    def test_dead_missing_or_invalid_pane_is_not_a_live_process(self):
        for response in [result(1), result(0, '123 1'), result(0, '1 0'), result(0, 'not-a-pid 0'), result(0, '')]:
            with patch.object(m, 'tmux', return_value=response):
                self.assertIsNone(m.pane_pid('/tmp/private.sock', '%0'))
        with patch.object(m, 'tmux', return_value=result(0, '123 0')):
            self.assertEqual(m.pane_pid('/tmp/private.sock', '%0'), 123)

    def test_tmux_always_uses_explicit_socket_and_ignores_global_configuration(self):
        with patch.object(m.subprocess, 'run', return_value=result()) as run:
            m.tmux('/tmp/private.sock', 'list-sessions')
        self.assertEqual(run.call_args.args[0][:5], ['/usr/bin/tmux', '-S', '/tmp/private.sock', '-f', '/dev/null'])
        self.assertEqual(run.call_args.kwargs['timeout'], 5)

    def test_stop_does_not_signal_replaced_pid(self):
        with patch.object(m, 'pane_pid', return_value=999), patch.object(m.os, 'kill') as kill:
            m.stop_pane('/tmp/private.sock', '%0', 123, 1)
        kill.assert_not_called()

    def test_stop_sends_term_and_waits_for_exit(self):
        with patch.object(m, 'pane_pid', side_effect=[123, None]), patch.object(m.os, 'kill') as kill:
            m.stop_pane('/tmp/private.sock', '%0', 123, 1)
        kill.assert_called_once_with(123, signal.SIGTERM)

    @patch.object(m.signal, 'signal')
    @patch.object(Path, 'mkdir')
    def test_refuses_to_adopt_existing_server(self, _mkdir, _signals):
        with patch.object(m, 'tmux', return_value=result()) as tmux:
            with self.assertRaisesRegex(RuntimeError, 'refusing takeover'):
                m.supervise(self.args())
        self.assertEqual(len(tmux.call_args_list), 1)

    @patch.object(m.signal, 'signal')
    @patch.object(Path, 'mkdir')
    def test_process_exit_requests_restart_and_cleans_private_server(self, _mkdir, _signals):
        with patch.object(m, 'tmux', side_effect=[result(1), result(0, '%0 123'), result()]) as tmux, \
             patch.object(m, 'pane_pid', side_effect=[123, None, None]), patch.object(m.time, 'sleep'):
            args = self.args()
            args.session = 'sales'
            args.cwd = '/home/sales'
            self.assertEqual(m.supervise(args), 1)
        start = tmux.call_args_list[1].args
        self.assertEqual(start[start.index('-s') + 1], 'sales')
        self.assertEqual(start[start.index('-c') + 1], '/home/sales')
        self.assertEqual(tmux.call_args_list[-1].args, (self.args().socket, 'kill-server'))
        self.assertEqual(tmux.call_args_list[1].args[-1], 'exec /usr/bin/pi --whatsapp-pi-online')

    @patch.object(Path, 'mkdir')
    def test_service_stop_is_graceful_and_returns_success(self, _mkdir):
        handlers = {}
        with patch.object(m.signal, 'signal', side_effect=lambda sig, fn: handlers.update({sig: fn})), \
             patch.object(m, 'tmux', side_effect=[result(1), result(0, '%0 123'), result()]), \
             patch.object(m, 'pane_pid', return_value=123), patch.object(m, 'stop_pane') as stop, \
             patch.object(m.time, 'sleep', side_effect=lambda _: handlers[signal.SIGTERM](signal.SIGTERM, None)):
            self.assertEqual(m.supervise(self.args()), 0)
        stop.assert_called_once_with(self.args().socket, '%0', 123, 1)

    @patch.object(m.signal, 'signal')
    @patch.object(Path, 'mkdir')
    def test_start_failure_does_not_kill_an_unowned_server(self, _mkdir, _signals):
        with patch.object(m, 'tmux', side_effect=[result(1), result(1)]) as tmux:
            with self.assertRaisesRegex(RuntimeError, 'Could not start'):
                m.supervise(self.args())
        self.assertFalse(any('kill-server' in call.args for call in tmux.call_args_list))


if __name__ == '__main__':
    unittest.main()
