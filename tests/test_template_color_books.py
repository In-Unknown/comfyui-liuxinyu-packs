import sys
import struct
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from template_color_books import read_book


class BookTests(unittest.TestCase):
    def test_acb_cmyk_source_and_name(self):
        def text(s):
            return struct.pack('>I', len(s)) + s.encode('utf-16-be')
        data = b'8BCB' + struct.pack('>HH', 1, 0)
        data += b''.join(text(s) for s in ['Example', 'Sample ', ' Z', 'Test'])
        data += struct.pack('>HHHH', 1, 1, 0, 2)
        data += text('91') + b'000091' + bytes([217, 255, 242, 204])
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)/'test.acb'
            p.write_bytes(data)
            book = read_book(p)
            self.assertEqual(book['colors'][0]['name'], 'Sample 91 Z')
            self.assertEqual([round(v) for v in book['colors'][0]['values']], [15,0,5,20])
            p.write_bytes(data[:-1])
            with self.assertRaises(ValueError): read_book(p)

if __name__ == '__main__': unittest.main()
