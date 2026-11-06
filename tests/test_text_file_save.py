"""Text saving contracts against the real ComfyUI V3 API and filesystem."""

import asyncio
import math
from pathlib import Path
import sys
import tempfile
import unittest

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK), str(PACK.parents[1])]

from text_file_node import LiuxinyuSaveTextFile as SaveText
import execution


class TextFileSaveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)

    def save(self, text, name="report.txt", overwrite=True):
        return SaveText.execute(text, str(self.folder), name, overwrite)

    def test_arbitrary_suffixes_preserve_exact_utf8_bytes(self):
        text = "  中文🙂\r\nLF\nCR\r literal \\n \t"
        for name in ("report.txt", "report.json", "Demo.cs", "data.png", "README"):
            with self.subTest(name=name):
                self.save(text, name)
                self.assertEqual((self.folder / name).read_bytes(), text.encode("utf-8"))

    def test_overwrite_truncates_and_allows_empty_text(self):
        self.save("long original content")
        self.save("新")
        self.assertEqual((self.folder / "report.txt").read_bytes(), "新".encode())
        self.save("")
        self.assertEqual((self.folder / "report.txt").read_bytes(), b"")

    def test_numbering_skips_files_and_directories(self):
        for name, numbered in (("report.json", "report_{}.json"),
                               ("README", "README_{}"),
                               ("report.backup.json", "report.backup_{}.json")):
            with self.subTest(name=name):
                (self.folder / name).mkdir()
                (self.folder / numbered.format(1)).write_bytes(b"keep")
                (self.folder / numbered.format(2)).mkdir()
                self.save("new", name, False)
                self.assertEqual((self.folder / numbered.format(3)).read_bytes(), b"new")
                self.assertEqual((self.folder / numbered.format(1)).read_bytes(), b"keep")
                self.save("next", name, False)
                self.assertEqual((self.folder / numbered.format(4)).read_bytes(), b"next")

    def test_parent_creation_and_path_whitespace(self):
        target = self.folder / "new" / "nested"
        SaveText.execute(" x ", f" {target} ", " report.json ", True)
        self.assertEqual((target / "report.json").read_bytes(), b" x ")

    def test_rejects_invalid_paths_before_writing(self):
        for folder in ("", "  ", "relative"):
            with self.subTest(folder=folder), self.assertRaises(ValueError):
                SaveText.execute("text", folder, "file.txt")
        for name in ("", ".", "..", "../outside.txt", r"sub\file.txt", "C:file.txt", "file.txt:stream", "file."):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.save("text", name)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_invalid_text_does_not_truncate_existing_file(self):
        self.save("keep")
        for value, error in (({}, ValueError), ([], ValueError), ("\ud800", UnicodeEncodeError)):
            with self.subTest(value=repr(value)), self.assertRaises(error):
                self.save(value)
            self.assertEqual((self.folder / "report.txt").read_bytes(), b"keep")

    def test_overwrite_does_not_delete_directory(self):
        (self.folder / "report.txt").mkdir()
        with self.assertRaises(OSError):
            self.save("text")
        self.assertTrue((self.folder / "report.txt").is_dir())

    def test_output_schema_and_no_save_result_cache(self):
        schema = SaveText.define_schema()
        self.assertTrue(schema.is_output_node)
        self.assertEqual(schema.outputs, [])
        self.assertEqual([value.id for value in schema.inputs], ["text", "folder", "filename", "overwrite"])
        self.assertTrue(math.isnan(SaveText.fingerprint_inputs()))

    def test_real_executor_maps_texts_and_repeats_short_inputs(self):
        for overwrite in (False, True):
            folder = self.folder / str(overwrite)
            output, ui, _, _ = asyncio.run(execution.get_output_data(
                "text-save-test", "save", SaveText,
                {"text": ["first", "second", "第三"], "folder": [str(folder)],
                 "filename": ["report.json"], "overwrite": [overwrite]}))
            self.assertEqual(output, [])
            self.assertEqual(len(ui["text"]), 3)
            if overwrite:
                self.assertEqual((folder / "report.json").read_text(encoding="utf-8"), "第三")
                self.assertEqual(len(list(folder.iterdir())), 1)
            else:
                for name, expected in (("report.json", "first"), ("report_1.json", "second"), ("report_2.json", "第三")):
                    self.assertEqual((folder / name).read_text(encoding="utf-8"), expected)


if __name__ == "__main__":
    unittest.main()
