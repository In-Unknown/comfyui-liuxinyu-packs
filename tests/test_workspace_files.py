import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from aiohttp import web


server = SimpleNamespace(instance=SimpleNamespace(routes=web.RouteTableDef()))
spec = importlib.util.spec_from_file_location(
    "workspace_files_tested", Path(__file__).resolve().parents[1] / "workspace_files.py",
)
module = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"server": SimpleNamespace(PromptServer=server)}):
    spec.loader.exec_module(module)


class Request:
    content_type = "application/json"

    def __init__(self, data):
        self.data = data

    async def json(self):
        return self.data


class WorkspaceFilesTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.user_root = Path(self.temp.name)
        self.root = self.user_root / "workflows"
        self.root.mkdir()
        self.relative = "项目 空格/说明%20文档.md"
        self.file = self.root / self.relative
        self.file.parent.mkdir()
        self.file.write_text("# 文档", encoding="utf-8")
        self.manager = Mock()
        self.manager.get_request_user_filepath.return_value = str(self.user_root)
        server.instance.user_manager = self.manager

    async def test_open_preserves_filename_and_uses_current_user(self):
        request = Request({"path": self.relative})
        with patch.object(module.os, "startfile") as start:
            response = await module.open_workspace_file(request)
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body), {"opened": True})
        start.assert_called_once_with(str(self.file.resolve()), "open")
        self.manager.get_request_user_filepath.assert_called_once_with(request, None, create_dir=False)

    async def test_rejects_paths_outside_workspace(self):
        for path in ("../secret.md", "dir/../../secret.md", "C:/secret.md", "/secret.md",
                     "\\\\server\\share\\x.md", "x.md:stream"):
            with self.subTest(path=path), patch.object(module.os, "startfile") as start:
                response = await module.open_workspace_file(Request({"path": path}))
                self.assertEqual(response.status, 400)
                start.assert_not_called()

    async def test_json_documents_open_externally(self):
        for content in ({"dataset_metadata": {"platform": "撰写要求"}, "report": []},
                        [{"topic": "承重"}], [], 42, None):
            target = self.root / "报告.JSON"
            target.write_text(json.dumps(content), encoding="utf-8-sig")
            with self.subTest(content=content), patch.object(module.os, "startfile") as start:
                response = await module.open_workspace_file(Request({"path": target.name}))
                self.assertEqual(json.loads(response.body), {"opened": True})
                start.assert_called_once_with(str(target.resolve()), "open")

    async def test_damaged_or_uncertain_workflows_never_open_externally(self):
        cases = [
            '{"nodes": [], "links": []}',
            '{"nodes": "broken", "version": 999}',
            '{"nodes": [{"type":"MissingCustomNode"}], "links": [["broken"]]}',
            '{"custom_id": {"class_type": "MissingNode", "inputs": {}}}',
            '{"42:3": {"broken": true}}',
            '{"workflow": {"nodes": []}}',
            '{"payload": {"nodes": []}}',
            '{"nodes": [', '{}',
        ]
        target = self.root / "流程.app.json"
        for content in cases:
            target.write_text(content, encoding="utf-8")
            with self.subTest(content=content), patch.object(module.os, "startfile") as start:
                response = await module.open_workspace_file(Request({"path": target.name}))
                self.assertEqual(json.loads(response.body), {"opened": False, "action": "workflow"})
                start.assert_not_called()

    async def test_missing_file_and_directory_are_not_opened(self):
        for path in ("missing.md", "项目 空格"):
            with self.subTest(path=path), patch.object(module.os, "startfile") as start:
                response = await module.open_workspace_file(Request({"path": path}))
                self.assertEqual(response.status, 404)
                start.assert_not_called()

    async def test_invalid_payload_and_unknown_user(self):
        with patch.object(module.os, "startfile") as start:
            for data in ([], {}, {"path": 123}):
                response = await module.open_workspace_file(Request(data))
                self.assertEqual(response.status, 400)
            self.manager.get_request_user_filepath.side_effect = KeyError("unknown user")
            response = await module.open_workspace_file(Request({"path": self.relative}))
            self.assertEqual(response.status, 403)
            start.assert_not_called()

    async def test_missing_association_reports_actionable_error(self):
        error = OSError("No association")
        error.winerror = 1155
        with patch.object(module.os, "startfile", side_effect=error):
            response = await module.open_workspace_file(Request({"path": self.relative}))
        self.assertEqual(response.status, 500)
        self.assertIn("默认程序", json.loads(response.body)["error"])

    async def test_only_json_requests_can_launch(self):
        request = Request({"path": self.relative})
        request.content_type = "text/plain"
        with patch.object(module.os, "startfile") as start:
            response = await module.open_workspace_file(request)
            self.assertEqual(response.status, 400)
            start.assert_not_called()

    def test_resolved_symlink_cannot_escape_workspace(self):
        outside = self.user_root / "outside.md"
        outside.write_text("outside", encoding="utf-8")
        link = self.root / "linked.md"
        try:
            link.symlink_to(outside)
        except OSError as error:
            self.skipTest(f"当前 Windows 不允许创建测试符号链接：{error}")
        with self.assertRaises(ValueError):
            module.resolve_workspace_file(self.user_root, "linked.md")


if __name__ == "__main__":
    unittest.main()
