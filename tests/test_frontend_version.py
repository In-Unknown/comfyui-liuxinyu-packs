import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

spec=importlib.util.spec_from_file_location('version_test',Path(__file__).parents[1]/'frontend_version.py')
module=importlib.util.module_from_spec(spec)
server=SimpleNamespace(instance=None)
with patch.dict(sys.modules,{'server':SimpleNamespace(PromptServer=server)}):spec.loader.exec_module(module)

class Tests(unittest.IsolatedAsyncioTestCase):
    def test_versions_track_frontend_and_loaded_backend(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'a.py').write_text('a');(root/'a.js').write_text('a')
            versions=module.Versions(root);before=versions.version()
            (root/'a.py').write_text('backend changed')
            self.assertEqual(before,versions.version())
            self.assertNotEqual(before,module.Versions(root).version())
            (root/'a.js').write_text('frontend changed')
            self.assertNotEqual(before,versions.version())
    async def test_only_stale_connected_page_is_notified(self):
        server.instance=SimpleNamespace(sockets={'page':object()},send_sync=Mock())
        class Request:
            content_type='application/json'
            async def json(self):return self.data
        request=Request()
        with patch.object(module.versions,'version',return_value='new'):
            request.data={'client_id':'page','version':'new'}
            self.assertEqual((await module.report_version(request)).status,200)
            server.instance.send_sync.assert_not_called()
            request.data['version']='old';await module.report_version(request)
            server.instance.send_sync.assert_called_once_with('liuxinyu.frontend_reload',{'version':'new'},'page')
            request.data['client_id']='missing'
            self.assertEqual((await module.report_version(request)).status,409)

if __name__=='__main__':unittest.main()
