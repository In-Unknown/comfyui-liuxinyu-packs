"""Explicit standalone Windows call tracing; never imported by the node loader.

Run with a diagnostic Python environment containing frida. This observes Edge
browser processes and Explorer; it never changes window state or API arguments.
"""
import argparse
import ctypes as c
from ctypes import wintypes as w
from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import threading
import time


def discover():
    user, kernel = c.WinDLL('user32'), c.WinDLL('kernel32')
    cb = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    user.EnumWindows.argtypes = [cb, w.LPARAM]
    user.GetWindowThreadProcessId.argtypes = [w.HWND, c.POINTER(w.DWORD)]
    user.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, c.c_int]
    user.GetShellWindow.restype = w.HWND
    kernel.OpenProcess.argtypes, kernel.OpenProcess.restype = [w.DWORD, w.BOOL, w.DWORD], w.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    processes, targets, paths = {}, [], {}

    def process_path(pid):
        if pid in paths:
            return paths[pid]
        handle = kernel.OpenProcess(0x1000, False, pid)
        path = ''
        if handle:
            try:
                buf, size = c.create_unicode_buffer(2048), w.DWORD(2048)
                if kernel.QueryFullProcessImageNameW(handle, 0, buf, c.byref(size)):
                    path = buf.value
            finally:
                kernel.CloseHandle(handle)
        paths[pid] = path
        return path

    @cb
    def window(hwnd, _):
        name = c.create_unicode_buffer(256)
        user.GetClassNameW(hwnd, name, len(name))
        if name.value != 'Chrome_WidgetWin_1':
            return True
        pid = w.DWORD()
        user.GetWindowThreadProcessId(hwnd, c.byref(pid))
        path = process_path(pid.value)
        if Path(path).name.lower() == 'msedge.exe':
            targets.append(hex(hwnd))
            processes[pid.value] = path
        return True

    user.EnumWindows(window, 0)
    shell = user.GetShellWindow()
    if shell and targets:
        pid = w.DWORD()
        user.GetWindowThreadProcessId(shell, c.byref(pid))
        path = process_path(pid.value)
        if Path(path).name.lower() == 'explorer.exe':
            processes[pid.value] = path
    return processes, sorted(targets)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    import frida
    from focus_evidence import EvidenceStore
    args.directory.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(args.directory/'focus-calls.jsonl', maxBytes=4*1024*1024,
                                  backupCount=3, encoding='utf-8')
    logger = logging.Logger('liuxinyu.native-calls', logging.INFO)
    logger.addHandler(handler)
    lock = threading.RLock()
    sessions, attached, attempts = {}, {}, {}
    status = {'pid': os.getpid(), 'state': 'starting', 'processes': attached,
              'calls': 0, 'errors': 0, 'targets': [], 'lastCall': None}
    stop = args.directory/'focus-calls.stop'
    status_path = args.directory/'focus-calls-state.json'
    source = Path(__file__).with_suffix('.frida').read_text(encoding='utf-8')
    evidence = EvidenceStore(args.directory, Path(__file__).resolve().parents[4])

    def save_state():
        with lock:
            status['updatedAt'] = datetime.now(timezone.utc).isoformat()
            tmp = status_path.with_suffix('.tmp')
            tmp.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding='utf-8')
            tmp.replace(status_path)

    def emit(event):
        with lock:
            logger.info(json.dumps({'receivedAt': datetime.now(timezone.utc).isoformat(), **event}, ensure_ascii=False))
            try:
                evidence.observe(event)
            except Exception as exc:
                status['errors'] += 1
                evidence.last_error = repr(exc)
            if event.get('kind') == 'call':
                status['calls'] += 1
                status['lastCall'] = {k: event[k] for k in ('pid', 'api', 'time', 'hwnd')}
            if event.get('type') == 'error' or event.get('kind') == 'attach-error':
                status['errors'] += 1

    emit({'kind': 'observer-start', 'pid': os.getpid(), 'fridaVersion': frida.__version__})
    try:
        while not stop.exists():
            try:
                evidence.tick()
            except OSError as exc:
                evidence.last_error = repr(exc)
                status['errors'] += 1
            status['evidence'] = {'directory': str(evidence.root), 'lastIncident': evidence.last_incident,
                                  'lastError': evidence.last_error}
            wanted, targets = discover()
            status['targets'] = targets
            for pid, (session, script) in list(sessions.items()):
                if pid not in wanted or attached.get(str(pid), {}).get('state') == 'detached':
                    try:
                        session.detach()
                    except frida.InvalidOperationError:
                        pass
                    del sessions[pid]
                    with lock:
                        attached.pop(str(pid), None)
            for pid, path in wanted.items():
                if pid in sessions:
                    if targets != attached[str(pid)].get('targets'):
                        try:
                            sessions[pid][1].exports_sync.targets(targets)
                            attached[str(pid)]['targets'] = targets
                        except frida.InvalidOperationError:
                            attached[str(pid)]['state'] = 'detached'
                    continue
                if time.monotonic() - attempts.get(pid, -1000) < 60:
                    continue
                attempts[pid] = time.monotonic()
                session = None
                try:
                    session = frida.attach(pid)
                    with lock:
                        attached[str(pid)] = {'path': path, 'state': 'loading', 'targets': targets}
                    def detached(reason, crash, pid=pid):
                        with lock:
                            if str(pid) in attached:
                                attached[str(pid)].update(state='detached', reason=str(reason))
                        emit({'kind': 'detached', 'pid': pid, 'reason': str(reason)})
                    session.on('detached', detached)
                    script = session.create_script(source.replace('__TARGETS__', json.dumps(targets)))
                    def message(data, binary, pid=pid):
                        event = data.get('payload', data)
                        if event.get('kind') == 'ready':
                            with lock:
                                attached[str(pid)].update(state='attached', hooks=event['hooks'])
                        emit(event)
                    script.on('message', message)
                    script.load()
                    sessions[pid] = session, script
                except Exception as exc:
                    if session:
                        try:
                            session.detach()
                        except frida.InvalidOperationError:
                            pass
                    with lock:
                        attached[str(pid)] = {'path': path, 'state': 'failed', 'error': str(exc)}
                    emit({'kind': 'attach-error', 'pid': pid, 'errorType': type(exc).__name__, 'error': str(exc)})
            status['state'] = ('active' if wanted and all(attached.get(str(pid), {}).get('state') == 'attached'
                                                       for pid in wanted) else 'partial' if wanted else 'waiting_for_edge')
            save_state()
            time.sleep(5)
    finally:
        for session, script in sessions.values():
            try:
                session.detach()
            except frida.InvalidOperationError:
                pass
        status['state'] = 'stopped'
        evidence.close()
        save_state()
        emit({'kind': 'observer-stop'})


if __name__ == '__main__':
    main()
