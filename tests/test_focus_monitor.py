import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

sys.modules.setdefault('folder_paths',types.SimpleNamespace(get_user_directory=lambda:'.'))
sys.modules['server']=types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(post=lambda p:lambda fn:fn,get=lambda p:lambda fn:fn))))
spec=importlib.util.spec_from_file_location('focus_monitor',Path(__file__).parents[1]/'focus_monitor.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class FocusTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        m.folder_paths.get_user_directory=lambda:self.temp.name
        m._logger=None;m._native=types.SimpleNamespace(status='test')
        app=web.Application()
        app.router.add_post('/events',m.focus_events);app.router.add_get('/status',m.focus_status)
        self.client=TestClient(TestServer(app));await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        if m._logger:
            for handler in m._logger.handlers:handler.close()
        self.temp.cleanup()

    async def test_save_whitelisted_events_and_status(self):
        data={'session':'s1','dropped':3,'records':[{'kind':'HTMLElement.focus','stack':'caller.js:9',
              'sequence':1,'hasFocus':False,'value':'private','target':{'tag':'INPUT','value':'private'},
              'viewport':[1920,1080],'userActivation':{'active':False}}]}
        response=await self.client.post('/events',json=data)
        self.assertEqual(response.status,200)
        rows=[json.loads(s) for s in m.log_path().read_text(encoding='utf8').splitlines()]
        self.assertEqual(rows[0]['session'],'s1');self.assertEqual(rows[0]['stack'],'caller.js:9')
        self.assertEqual(rows[1]['dropped'],3);self.assertNotIn('private',json.dumps(rows))
        response=await self.client.get('/status');self.assertEqual((await response.json())['native'],'test')

    async def test_reject_bad_or_oversized_batch(self):
        for data in ({},[],{'session':'s','records':[]},{'session':'s','records':[{}]},
                     {'session':'s','records':[{'kind':'focus'}]*41}):
            response=await self.client.post('/events',json=data);self.assertEqual(response.status,400)
        response=await self.client.post('/events',data=b'x'*196609);self.assertEqual(response.status,413)
        self.assertFalse(m.log_path().exists())

    async def test_log_rotation_is_bounded(self):
        m.write_event('test',{'kind':'start'})
        m._logger.handlers[0].maxBytes=300
        for i in range(50):m.write_event('test',{'kind':'sample','sequence':i,'stack':'a'*100})
        files=list(m.log_path().parent.glob('focus.jsonl*'))
        self.assertEqual(len(files),4)
        self.assertTrue(all(p.stat().st_size<600 for p in files))
        last=json.loads(m.log_path().read_text(encoding='utf8').splitlines()[-1]);self.assertEqual(last['sequence'],49)


if __name__=='__main__':unittest.main()
