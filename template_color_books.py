"""Read installed Adobe ACB books without copying licensed palettes into the package."""
from pathlib import Path
import os
import struct


def installed_books():
    adobe = Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Adobe'
    return sorted(adobe.glob('*/Presets/*/*/*/*.acb')) if adobe.is_dir() else []


def read_book(path):
    data = Path(path).read_bytes()
    offset = 0
    def take(n):
        nonlocal offset
        chunk = data[offset:offset+n]
        if len(chunk) != n:
            raise ValueError('色标簿数据不完整')
        offset += n
        return chunk
    def number():
        return struct.unpack('>H', take(2))[0]
    def string():
        size = struct.unpack('>I', take(4))[0]
        if size > 10000:
            raise ValueError('色标簿字符串过长')
        return take(size*2).decode('utf-16-be').replace('\x00', '')
    if take(4) != b'8BCB' or number() != 1:
        raise ValueError('不支持此 ACB 版本')
    number()
    title, prefix, suffix, description = [string() for _ in range(4)]
    count, page_size, page_offset, space = [number() for _ in range(4)]
    channels = {0: 3, 2: 4, 7: 3}.get(space)
    if channels is None:
        raise ValueError('不支持此色标簿颜色空间')
    def label(s):
        return s.split('=', 1)[-1] if s.startswith('$$$') else s
    colors = []
    for _ in range(count):
        name = string()
        take(6)
        components = list(take(channels))
        if not name:
            continue
        if space == 2:
            components = [(255-v)*100/255 for v in components]
        elif space == 7:
            components = [components[0]*100/255, components[1]-128, components[2]-128]
        colors.append({'name': label(prefix)+label(name)+label(suffix),
                       'space': {0:'rgb',2:'cmyk',7:'lab'}[space], 'values': components})
    return {'name': label(title), 'colors': colors}
