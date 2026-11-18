import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import unittest

spec = importlib.util.spec_from_file_location('focus_recorder', Path(__file__).parents[1] / 'focus_recorder.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RecorderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.commands = []
        self.recording = True
        self.failed_save = False
        self.events = []
        self.recorder = m.FocusRecorder(self.temp.name, lambda *args: self.events.append(args), self.run_command,
                                       snapshot=lambda *args: {"buffers": []})

    def run_command(self, args):
        self.commands.append(args)
        if 'focus_report.py' in ' '.join(args):
            return 0, 'decoded'
        self.assertEqual(args[-2:], ['-instancename', 'LiuxinyuFocus'])
        if '-status' in args:
            return 0, 'Microsoft-Windows-Win32k Stack Events Lost: 0' if self.recording else 'not recording'
        if '-stop' in args:
            self.recording = False
            return (5, 'access denied') if self.failed_save else (0, 'saved')
        if '-start' in args:
            self.recording = True
        return 0, ''

    def event(self, kind, tick, minimized=False, hwnd=12, foreground=44):
        self.recorder.observe('windows', {'kind': kind, 'systemTickMs': tick,
                              'window': {'hwnd': hwnd, 'minimized': minimized},
                              'foreground': {'hwnd': foreground}})

    def test_rapid_restore_uses_event_time_including_tick_wrap(self):
        self.event('minimize-start', 0xfffffff0, True)
        self.event('foreground', 0x10)
        reason = self.recorder.pending.get_nowait()
        self.assertEqual(reason['elapsedMs'], 32)
        self.event('minimize-end', 0x11)
        self.assertTrue(self.recorder.pending.empty())

    def test_normal_restore_and_other_window_do_not_trigger(self):
        self.event('minimize-start', 100, True)
        self.event('foreground', 140, hwnd=99)
        self.event('minimize-end', 90000)
        self.assertTrue(self.recorder.pending.empty())

    def test_background_flash_triggers_but_foreground_flash_does_not(self):
        self.event('shell-flash', None, foreground=12)
        self.assertTrue(self.recorder.pending.empty())
        self.event('shell-flash', None)
        self.assertEqual(self.recorder.pending.get_nowait()['kind'], 'background-taskbar-flash')
        self.event('shell-flash', None)
        self.assertTrue(self.recorder.pending.empty(), 'Burst is coalesced')

    def test_capture_preserves_evidence_on_save_failure_and_rearms(self):
        self.failed_save = True
        root = Path(self.temp.name)
        (root/'focus.jsonl').write_text('page evidence', encoding='utf8')
        self.recorder.observe('page', {'kind': 'window.focus', 'stack': 'origin.js:2'})
        self.recorder.capture({'kind': 'validation'})
        report = json.loads(Path(self.recorder.last_capture).read_text(encoding='utf8'))
        self.assertEqual(report['saveReturnCode'], 5)
        self.assertEqual(report['recent'][0]['stack'], 'origin.js:2')
        self.assertEqual(next(root.glob('focus-incident-*-focus.jsonl')).read_text(), 'page evidence')
        self.assertEqual(self.recorder.status, 'recording')
        self.assertTrue(any('-start' in args for args in self.commands))
        self.assertEqual(self.recorder.last_capture_result['state'], 'save_failed')

    def test_raw_snapshot_survives_com_export_failure(self):
        self.failed_save = True
        def snapshot(prefix, reason):
            self.assertTrue(prefix.with_suffix('.json').is_file())
            path = Path(str(prefix) + '.events.etl')
            path.write_bytes(b'raw ETW')
            return {'buffers': [{'path': str(path), 'flushCode': 0, 'bytes': 7}]}
        self.recorder.snapshot = snapshot
        self.recorder.capture({'kind': 'validation'})
        self.assertEqual(self.recorder.last_capture_result['state'], 'raw_saved')
        self.assertTrue(any('.events.etl' in ' '.join(args) and 'focus_report.py' in ' '.join(args)
                            for args in self.commands))
        state = json.loads((Path(self.temp.name)/'focus-recorder-state.json').read_text())
        self.assertEqual(state['state'], 'recording')
        self.assertEqual(state['lastCaptureResult']['state'], 'raw_saved')
        restarted = m.FocusRecorder(self.temp.name, lambda *args: None)
        self.assertEqual(restarted.last_capture_result, self.recorder.last_capture_result)

    def test_timeout_preserves_report_and_failure_status(self):
        original = self.recorder.run
        def run(args):
            if '-stop' in args:
                raise subprocess.TimeoutExpired(args, 60)
            return original(args)
        self.recorder.run = run
        self.recorder.capture({'kind': 'validation'})
        report = json.loads(Path(self.recorder.last_capture).read_text())
        self.assertEqual(report['saveReturnCode'], -1)
        self.assertEqual(self.recorder.last_capture_result['state'], 'save_failed')

    def test_adopts_named_session_and_bounds_ring(self):
        self.assertTrue(self.recorder.arm())
        self.assertEqual(len(self.commands), 1)
        for i in range(2200):
            self.recorder.observe('page', {'kind': 'focus', 'sequence': i})
        self.assertEqual(len(self.recorder.recent), 2000)

    def test_old_incident_is_archived_with_native_calls_instead_of_deleted(self):
        root = Path(self.temp.name)
        for index in range(8):
            prefix = root/f'focus-incident-20260101T000000{index:06d}Z'
            prefix.with_suffix('.json').write_text('{}')
            Path(str(prefix)+'-focus-calls.jsonl').write_text('native evidence')
        (root/'focus-calls.jsonl').write_text('current native evidence')
        (root/'focus-calls-state.json').write_text('{}')
        self.failed_save = True
        self.recorder.capture({'kind':'validation'})
        archived = list((root/'focus-preserved').glob('*/**/*-focus-calls.jsonl'))
        self.assertEqual(len(archived), 1)
        self.assertEqual(archived[0].read_text(), 'native evidence')
        self.assertEqual(Path(self.recorder.last_capture.replace('.json','-focus-calls.jsonl')).read_text(), 'current native evidence')


if __name__ == '__main__':
    unittest.main()
