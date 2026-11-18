import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('focus_evidence', Path(__file__).parents[1]/'diagnostics/focus_evidence.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = m.EvidenceStore(self.root/'diagnostics', self.root, tail_seconds=30)
        self.addCleanup(self.store.close)

    def test_file_replacement_and_deletion_do_not_destroy_snapshot(self):
        source = self.root/'code.dll'
        source.write_bytes(b'original code')
        first = self.store.freeze_file(source)
        source.write_bytes(b'new code with different length')
        second = self.store.freeze_file(source)
        source.unlink()
        self.assertNotEqual(first['sha256'], second['sha256'])
        self.assertEqual(gzip.decompress((self.store.root/first['object']).read_bytes()), b'original code')

    def test_incident_retains_call_return_modules_and_preceding_events(self):
        self.store.observe({'kind':'ready', 'pid':7, 'session':'7-one', 'modules':[]})
        self.store.observe({'kind':'call', 'pid':7, 'id':1, 'api':'ShowWindow', 'time':100,
                            'hwnd':'0x1', 'args':{'command':6}, 'minimizedBefore':False})
        self.store.observe({'kind':'call', 'pid':7, 'id':2, 'session':'7-one', 'api':'ShowWindow',
                            'time':131, 'hwnd':'0x1', 'args':{'command':9}, 'minimizedBefore':True,
                            'stack':[{'address':'0x123', 'module':'test.dll', 'offset':'0x23'}]})
        folder = Path(self.store.last_incident)
        self.assertTrue((folder/'manifest.json').is_file(), 'Manifest exists before background work finishes')
        self.store.observe({'kind':'return', 'pid':7, 'id':2, 'minimizedAfter':False})
        self.store.active['until'] = 0
        self.store.tick()
        events = [json.loads(line) for line in (folder/'native-calls.jsonl').read_text().splitlines()]
        self.assertEqual([event['kind'] for event in events], ['ready','call','call','return'])
        self.assertTrue(json.loads((folder/'manifest.json').read_text())['finalized'])
        self.assertTrue((self.store.root/'sessions/7-one.json').exists())
        for i in range(2200):self.store.observe({'kind':'ordinary', 'sequence':i})
        self.assertTrue((folder/'native-calls.jsonl').is_file(), 'Ring rotation cannot remove sealed incident')

    def test_flash_stop_and_foreground_flash_do_not_create_incident(self):
        base={'kind':'call','pid':7,'api':'FlashWindowEx','hwnd':'0x1','topWindow':'0x1'}
        self.store.observe({**base,'args':{'flags':0},'foreground':'0x2'})
        self.store.observe({**base,'args':{'flags':3},'foreground':'0x1'})
        self.assertIsNone(self.store.last_incident)
        self.store.observe({**base,'args':{'flags':3},'foreground':'0x2'})
        self.assertTrue(Path(self.store.last_incident).exists())


if __name__ == '__main__':
    unittest.main()
