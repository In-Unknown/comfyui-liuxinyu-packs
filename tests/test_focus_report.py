import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('focus_report', Path(__file__).parents[1]/'diagnostics'/'focus_report.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ReportTests(unittest.TestCase):
    def test_null_message_burst_cannot_displace_transition_stack(self):
        def event(index, event_id):
            return f'''<Event><System><Provider Name="Microsoft-Windows-Win32k"/>
                <EventID>{event_id}</EventID><Execution ProcessID="42" ThreadID="43"/>
                <TimeCreated SystemTime="2026-11-12T00:00:{index:05d}Z"/>
                <Stack><Address>0x1234</Address></Stack></System>
                <EventData><Data Name="SourceProcessId">42</Data></EventData></Event>'''
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'trace.xml'
            path.write_text('<Events xmlns="'+m.NS['e']+'">'+event(0,26)+
                            ''.join(event(i,426) for i in range(1,1501))+'</Events>', encoding='utf-8')
            report = m.summarize(path, target_pid=42)
        self.assertEqual(report['events'][0]['id'], 26)
        self.assertEqual(report['events'][0]['stack'], ['0x1234'])
        self.assertEqual(len(report['events']), 101)
        self.assertEqual(report['eventsWithStacks'], 1501)


if __name__ == '__main__':
    unittest.main()
