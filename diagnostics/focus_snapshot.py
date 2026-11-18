"""Save existing ETW memory buffers without WPR's COM merge/export path."""
import ctypes as c
from ctypes import wintypes as w
from pathlib import Path


class WnodeHeader(c.Structure):
    _fields_ = [("size", w.ULONG), ("provider", w.ULONG), ("context", c.c_ulonglong),
                ("stamp", c.c_longlong), ("guid", c.c_byte * 16),
                ("client", w.ULONG), ("flags", w.ULONG)]


class TraceProperties(c.Structure):
    _fields_ = [("header", WnodeHeader)] + [(name, w.ULONG) for name in (
        "buffer", "minimum", "maximum", "fileSize", "mode", "timer", "enable", "age",
        "number", "free", "lost", "written", "logLost", "rtLost")] + [
            ("thread", w.HANDLE), ("fileOffset", w.ULONG), ("nameOffset", w.ULONG)]


def save_buffers(prefix):
    api = c.WinDLL("advapi32").ControlTraceW
    api.argtypes = [c.c_ulonglong, w.LPCWSTR, c.POINTER(TraceProperties), w.ULONG]
    api.restype = w.ULONG
    results = []
    for collector, suffix in (("Liuxinyu Focus Events", ".events.etl"),
                              ("WPR System Collector", ".images.etl")):
        # Exact session names only; never enumerate or stop unrelated traces.
        name = "WPR_initiated_LiuxinyuFocus_" + collector
        buf = c.create_string_buffer(32768)
        props = c.cast(buf, c.POINTER(TraceProperties))
        props.contents.header.size = len(buf)
        props.contents.nameOffset = c.sizeof(TraceProperties)
        props.contents.fileOffset = c.sizeof(TraceProperties) + 4096
        code = api(0, name, props, 0)  # EVENT_TRACE_CONTROL_QUERY
        path = Path(str(prefix) + suffix).resolve()
        result = {"collector": name, "path": str(path), "queryCode": code}
        if not code:
            result.update(mode=props.contents.mode, eventsLost=props.contents.lost)
            if not props.contents.mode & 0x400:  # EVENT_TRACE_BUFFERING_MODE
                result["error"] = "Expected a memory-buffering session; left unchanged"
            else:
                props.contents.fileOffset = c.sizeof(TraceProperties) + 4096
                filename = c.create_unicode_buffer(str(path))
                if c.sizeof(filename) > len(buf) - props.contents.fileOffset:
                    raise ValueError("ETW snapshot path is too long")
                c.memmove(c.addressof(buf) + props.contents.fileOffset, filename, c.sizeof(filename))
                result["flushCode"] = api(0, name, props, 3)  # FLUSH, not STOP
                result["bytes"] = path.stat().st_size if path.is_file() else 0
        results.append(result)
    return results


def snapshot_modules(pid):
    """Capture ASLR ranges now, even when the process started before the ETW ring."""
    class ModuleEntry(c.Structure):
        _fields_ = [(name, w.DWORD) for name in
                    ("size", "moduleId", "processId", "globalUses", "processUses")] + [
            ("base", c.c_void_p), ("imageSize", w.DWORD), ("module", w.HMODULE),
            ("name", w.WCHAR * 256), ("path", w.WCHAR * 260)]

    kernel = c.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateToolhelp32Snapshot
    create.argtypes, create.restype = [w.DWORD, w.DWORD], w.HANDLE
    first, next_module = kernel.Module32FirstW, kernel.Module32NextW
    for fn in (first, next_module):
        fn.argtypes, fn.restype = [w.HANDLE, c.POINTER(ModuleEntry)], w.BOOL
    close = kernel.CloseHandle
    close.argtypes, close.restype = [w.HANDLE], w.BOOL
    handle = create(0x8, pid)
    if handle == c.c_void_p(-1).value:
        return {"pid": pid, "error": c.get_last_error(), "modules": []}
    entry = ModuleEntry()
    entry.size = c.sizeof(entry)
    modules = []
    try:
        ok = first(handle, c.byref(entry))
        error = c.get_last_error() if not ok else 0
        while ok:
            modules.append({"name": entry.name, "path": entry.path,
                            "base": entry.base, "size": entry.imageSize})
            ok = next_module(handle, c.byref(entry))
        return {"pid": pid, "error": error, "modules": modules}
    finally:
        close(handle)
